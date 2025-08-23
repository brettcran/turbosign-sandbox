/* TurboSign — app.mjs (stable features; tuned, bounded zoom; Safari guards scoped) */

//// ---------- Utilities ----------
const $ = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const once = (el, ev, cb, opts) => el && el.addEventListener(ev, function h(e){ el.removeEventListener(ev, h, opts); cb(e); }, opts);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const toast = (msg, kind='ok', t=3200) => { const n=$('#toast'); if(!n) return; n.textContent=msg; n.className=''; n.classList.add('show',kind); clearTimeout(n._t); n._t=setTimeout(()=>n.className='',t); };
async function headOK(url){ try{ const r=await fetch(url,{method:'HEAD',cache:'no-store'}); return r.ok; }catch{ return false; } }
function isValidPdfBytes(bytes){ if(!bytes||!bytes.length) return false; for (let i=0;i<8 && i+4<bytes.length;i++){ if (bytes[i]===0x25 && bytes[i+1]===0x50 && bytes[i+2]===0x44 && bytes[i+3]===0x46 && bytes[i+4]===0x2D) return true; } return false; }

//// ---------- PDF.js boot (ESM v5 + fallbacks) ----------
let pdfjsLib;
const CDN_VER='5.4.54', CDN_BASE=`https://cdn.jsdelivr.net/npm/pdfjs-dist@${CDN_VER}/build/`;
async function loadPdfJs(){
  const localCore = new URL('../build/pdf.mjs', import.meta.url).href;
  pdfjsLib = (await headOK(localCore)) ? await import(localCore) : await import(CDN_BASE + 'pdf.mjs');

  try{
    const localW = new URL('../build/pdf.worker.mjs', import.meta.url).href;
    if (await headOK(localW)) { const t=new Worker(localW,{type:'module'}); t.terminate(); pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(localW,{type:'module'}); return; }
  }catch{}

  try{
    const cdnW = CDN_BASE + 'pdf.worker.mjs';
    if (await headOK(cdnW)) { const t=new Worker(cdnW,{type:'module'}); t.terminate(); pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(cdnW,{type:'module'}); return; }
  }catch{}

  pdfjsLib.GlobalWorkerOptions.workerPort = null; // main thread fallback
}

// pdf-lib (ESM)
import { PDFDocument, rgb, StandardFonts } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

await loadPdfJs();

//// ---------- Refs & state ----------
const refs = {
  stage: $('#pdf-stage'),
  scroll: $('#pdf-scroll'),
  container: $('#pdf-container'),
  fileInput: $('#file-input'),
  openBtn: document.querySelector('[data-act="open"]'),
  textBtn: document.querySelector('[data-act="text"]'),
  stampBtn: document.querySelector('[data-act="stamp"]'),
  signBtn: document.querySelector('[data-act="sign"]'),
  undoBtn: document.querySelector('[data-act="undo"]'),
  redoBtn: document.querySelector('[data-act="redo"]'),
  helpBtn: document.querySelector('[data-act="help"]'),
  saveBtn: document.querySelector('[data-act="save"]'),
  sigModal: $('#sign-modal'), sigPad: $('#sig-pad'),
  sigUse: $('#sig-use'), sigClear: $('#sig-clear'), sigCancel: $('#sig-cancel'),
};
let CURRENT_PDF = { file:null, bytes:null, filename:null, wraps:[], vpCSSByPage:[] };
let LAST_SIG_DATAURL = null;

//// ---------- Scoped Safari pinch guards (only inside stage/scroll) ----------
['gesturestart','gesturechange','gestureend'].forEach(ev=>{
  refs.stage.addEventListener(ev, e=>{ e.preventDefault(); }, {passive:false});
  refs.scroll.addEventListener(ev, e=>{ e.preventDefault(); }, {passive:false});
});
refs.stage.addEventListener('touchmove', e=>{ if(e.touches?.length>1) e.preventDefault(); }, {passive:false});
refs.scroll.addEventListener('touchmove', e=>{ if(e.touches?.length>1) e.preventDefault(); }, {passive:false});

//// ---------- Zoom (fit-to-page default, bounded, damped) ----------
const zoom = {
  scale: 1,
  min: 0.5, max: 3.0, fit: 1, suspended:false,
  baseW:1, baseH:1,

  setBaseFromLayout(){
    let w=0,h=0;
    CURRENT_PDF.vpCSSByPage.forEach((vp,i)=>{ w=Math.max(w,vp.width); h+=vp.height; if(i>0) h+=12; });
    h += 20 + 140; // container vertical padding in CSS
    this.baseW=Math.max(1,w);
    this.baseH=Math.max(1,h);
  },

  computeFitScale(){
    const first = CURRENT_PDF.vpCSSByPage[0]; if(!first){ this.fit=1; return; }
    const availW = refs.scroll.clientWidth  - 24;
    const availH = refs.scroll.clientHeight - 160;
    const sH = availH / first.height;
    const sW = availW / Math.max(...CURRENT_PDF.vpCSSByPage.map(v=>v.width));
    this.fit = Math.max(0.3, Math.min(sH, sW));
    this.min = this.fit * 0.9;    // only slightly smaller than fit
    this.max = this.fit * 2.2;    // sane zoom-in cap
  },

  applyTransform(){
    refs.container.style.transformOrigin='0 0';
    refs.container.style.transform=`scale(${this.scale})`;
  },

  setScale(newScale, cx, cy){
    newScale = clamp(newScale, this.min, this.max);
    if (newScale === this.scale) return;

    const scroll = refs.scroll;
    const rect   = scroll.getBoundingClientRect();

    const contentW0 = this.baseW * this.scale;
    const contentH0 = this.baseH * this.scale;
    const contentW1 = this.baseW * newScale;
    const contentH1 = this.baseH * newScale;

    const gx0 = Math.max(0, (scroll.clientWidth  - contentW0) / 2);
    const gy0 = Math.max(0, (scroll.clientHeight - contentH0) / 2);
    const gx1 = Math.max(0, (scroll.clientWidth  - contentW1) / 2);
    const gy1 = Math.max(0, (scroll.clientHeight - contentH1) / 2);

    const contentX = (scroll.scrollLeft + (cx - rect.left) - gx0) / this.scale;
    const contentY = (scroll.scrollTop  + (cy - rect.top ) - gy0) / this.scale;

    this.scale = newScale;
    this.applyTransform();

    let newScrollLeft = contentX * this.scale - (cx - rect.left) + gx1;
    let newScrollTop  = contentY * this.scale - (cy - rect.top ) + gy1;

    const maxX = Math.max(0, contentW1 - scroll.clientWidth);
    const maxY = Math.max(0, contentH1 - scroll.clientHeight);
    scroll.scrollLeft = clamp(newScrollLeft, 0, maxX);
    scroll.scrollTop  = clamp(newScrollTop , 0, maxY);

    if (contentW1 <= scroll.clientWidth)  scroll.scrollLeft = 0;
    if (contentH1 <= scroll.clientHeight) scroll.scrollTop  = 0;
  }
};

// Pinch/trackpad wiring (with damping)
(function wirePinch(){
  const pts = new Map(); let lastDist=0, cx=0, cy=0, pinching=false;

  const down = (e)=>{ if(zoom.suspended) return; pts.set(e.pointerId,e);
    if(pts.size===2){ const [a,b]=[...pts.values()]; lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; pinching=true; refs.scroll.style.touchAction='none'; } };
  const move = (e)=>{ if(!pts.has(e.pointerId)) return; pts.set(e.pointerId,e);
    if(pinching && pts.size===2){
      const [a,b]=[...pts.values()];
      const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
      cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2;
      if(lastDist){
        // DAMPED zoom factor for smoothness
        const raw = d / lastDist;
        const damp = Math.pow(raw, 0.35); // 0.30–0.40 = gentle
        zoom.setScale(zoom.scale * damp, cx, cy);
      }
      lastDist=d; e.preventDefault();
    } };
  const up = (e)=>{ pts.delete(e.pointerId); if(pts.size<2){ pinching=false; lastDist=0; refs.scroll.style.touchAction='pan-y'; } };

  refs.scroll.addEventListener('pointerdown', down);
  refs.scroll.addEventListener('pointermove', move, {passive:false});
  refs.scroll.addEventListener('pointerup', up);
  refs.scroll.addEventListener('pointercancel', up);

  // Ctrl/⌘ + wheel zoom — very gentle step
  refs.scroll.addEventListener('wheel', (e)=>{ 
    if(!(e.ctrlKey||e.metaKey)) return;
    e.preventDefault();
    const step = Math.pow(1.0015, -e.deltaY);
    zoom.setScale(zoom.scale * step, e.clientX, e.clientY);
  }, {passive:false});
})();

function centerHorizontally(){
  const desired = Math.max(0, (zoom.baseW*zoom.scale - refs.scroll.clientWidth)/2);
  refs.scroll.scrollLeft = desired;
  const totalH = zoom.baseH * zoom.scale;
  if (totalH <= refs.scroll.clientHeight) refs.scroll.scrollTop = 0;
}
on(window,'resize', ()=>{ zoom.computeFitScale(); if(zoom.scale<zoom.min){ zoom.scale=zoom.min; zoom.applyTransform(); } centerHorizontally(); });

//// ---------- Annotations (same as stable) ----------
class Annotations{
  constructor(container){
    this.container=container; this.mode=null; this.overlays=[]; this.selected=null;
    this.history=[]; this.redoStack=[]; this.textStyle={ size:16, color:'#000', bold:false, italic:false, family:'Arial, sans-serif' };
    this.drag={ el:null, overlay:null, dx:0, dy:0 }; this.resize={ el:null, overlay:null, startW:0, startH:0, sx:0, sy:0 };
    on(document,'pointermove',e=>this._onMove(e),{passive:false});
    on(document,'pointerup',  e=>this._onUp(e));
  }
  setMode(m){ this.mode=m; ['text','stamp','sign'].forEach(k=>document.querySelector(`[data-act="${k}"]`)?.classList.toggle('active', this.mode===k)); this._select(null); }
  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove()); this.overlays=[];
    wrapInfos.forEach(({wrap})=>{
      const ov=document.createElement('div'); ov.className='overlay'; wrap.appendChild(ov);
      on(ov,'pointerdown', e=>{ if(e.target===ov) this._select(null); }, {passive:true});

      on(ov,'dblclick', e=>{
        if (e.target!==ov) return;
        if (this.mode==='text'){
          const {x,y}=this._pos(ov,e); this._addText(ov,x,y,true);
        } else if (this.mode==='sign'){
          if (!LAST_SIG_DATAURL){ toast('Draw a signature first','err'); sigCtl.open(); return; }
          const {x,y}=this._pos(ov,e);
          const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5);
          this._select(el); scrollAnnoIntoView(el);
        }
      });

      // mobile double‑tap
      let t=0,lx=0,ly=0;
      on(ov,'pointerdown', e=>{
        if(e.pointerType!=='touch'||e.target!==ov) return;
        const now=performance.now(); const {x,y}=this._pos(ov,e);
        const dbl=(now-t<300 && Math.abs(x-lx)<24 && Math.abs(y-ly)<24);
        t=now; lx=x; ly=y;
        if(!dbl) return;
        if (this.mode==='text'){ this._addText(ov,x,y,true); }
        else if (this.mode==='sign'){
          if(!LAST_SIG_DATAURL){ toast('Draw a signature first','err'); sigCtl.open(); return; }
          const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5);
          this._select(el); scrollAnnoIntoView(el);
        }
      }, {passive:true});

      // stamp single tap
      on(ov,'pointerdown', e=>{
        if(this.mode!=='stamp' || e.target!==ov) return;
        const {x,y}=this._pos(ov,e);
        this._addStamp(ov,x,y);
      }, {passive:true});

      this.overlays.push(ov);
    });
  }
  _pos(overlay,e){ const r=overlay.getBoundingClientRect(); return { x:(e.clientX-r.left)/zoom.scale, y:(e.clientY-r.top)/zoom.scale }; }
  _elSize(el){ return { w: el.offsetWidth, h: el.offsetHeight }; }

  _addText(overlay,x,y,focus){
    const el=document.createElement('div');
    el.className='anno text'; el.contentEditable='true';
    el.style.left=`${x}px`; el.style.top=`${y}px`;
    const st=this.textStyle;
    el.style.color=st.color; el.style.fontSize=`${Math.max(16,st.size)}px`;
    el.style.fontWeight=st.bold?'700':'400'; el.style.fontStyle=st.italic?'italic':'normal';
    el.style.fontFamily=st.family;
    overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:false});
    if(focus) this._focus(el);
    this._recordAdd(overlay, el);
  }

  _addStamp(overlay,x,y){
    const el=document.createElement('div');
    el.className='anno stamp'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    el.innerHTML=`<svg viewBox="0 0 24 24"><path d="M4 12l4 4 12-12"/></svg>`;
    overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:false});
    this._recordAdd(overlay, el);
  }

  _addSignature(overlay,x,y,dataURL,widthHint){
    const el=document.createElement('div');
    el.className='anno sign'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const img=new Image(); img.draggable=false; img.src=dataURL; img.style.display='block';
    el.appendChild(img); overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:true});
    img.onload=()=>{ const maxW=widthHint || Math.min(overlay.clientWidth*0.6, img.naturalWidth||img.width||300);
      img.style.width=maxW+'px'; img.style.height='auto'; scrollAnnoIntoView(el); };
    this._recordAdd(overlay, el);
    return el;
  }

  _wireAnno(el, overlay, {resizable}){
    const startDrag=(e)=>{
      if(el.classList.contains('text') && document.activeElement===el){ this._select(el); return; }
      const {x,y}=this._pos(overlay,e);
      const left=parseFloat(el.style.left)||0, top=parseFloat(el.style.top)||0;
      this.drag={ el, overlay, dx:x-left, dy:y-top };
      $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true;
      el.setPointerCapture?.(e.pointerId); this._select(el); e.preventDefault();
    };
    on(el,'pointerdown', startDrag, {passive:false});
    const innerImg=el.querySelector('img'); if(innerImg) on(innerImg,'pointerdown', startDrag, {passive:false});

    if(el.classList.contains('text')){
      on(el,'dblclick',()=>{ this._focus(el); this._select(el); });
    }

    if(resizable && !el.classList.contains('text')){
      const h=document.createElement('div'); h.className='handle br';
      Object.assign(h.style,{ position:'absolute', right:'-8px', bottom:'-8px', width:'14px', height:'14px',
        background:'#fff', border:'2px solid #4ea3ff', borderRadius:'3px', cursor:'nwse-resize', touchAction:'none' });
      el.appendChild(h);
      on(h,'pointerdown',e=>{
        e.stopPropagation();
        const { w, h:hh } = this._elSize(el);
        this.resize={ el, overlay, startW:w, startH:hh, sx:e.clientX, sy:e.clientY };
        $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true;
        h.setPointerCapture?.(e.pointerId);
      }, {passive:false});
    }
  }

  _onMove(e){
    if(this.drag.el){
      const {x,y}=this._pos(this.drag.overlay,e);
      let nx=x-this.drag.dx, ny=y-this.drag.dy;
      const W=this.drag.overlay.clientWidth, H=this.drag.overlay.clientHeight;
      const {w:ew,h:eh}=this._elSize(this.drag.el);
      nx=Math.max(0,Math.min(nx,W-ew)); ny=Math.max(0,Math.min(ny,H-eh));
      this.drag.el.style.left=`${nx}px`; this.drag.el.style.top=`${ny}px`;
      e.preventDefault(); return;
    }
    if(this.resize.el){
      const dx=(e.clientX-this.resize.sx)/zoom.scale;
      const w=Math.max(24,this.resize.startW+dx);
      const img=this.resize.el.querySelector('img');
      if(img){ img.style.width=w+'px'; img.style.height='auto'; }
      e.preventDefault();
    }
  }
  _onUp(e){
    if(this.drag.el){ try{this.drag.el.releasePointerCapture?.(e.pointerId)}catch{}; this.drag={el:null,overlay:null,dx:0,dy:0}; }
    if(this.resize.el){ try{this.resize.el.releasePointerCapture?.(e.pointerId)}catch{}; this.resize={el:null,overlay:null,startW:0,startH:0,sx:0,sy:0}; }
    $('#pdf-scroll').style.touchAction='pan-y'; zoom.suspended=false;
  }

  _focus(el){ el.focus(); const sel=getSelection(); const range=document.createRange(); range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); }
  _select(el){ this.container.querySelectorAll('.anno').forEach(n=>n.classList.remove('selected')); this.selected=el; if(el) el.classList.add('selected'); }
  _recordAdd(overlay, el){ this.history.push({type:'add',overlay,el}); this.redoStack.length=0; }

  undo(){ const last=this.history.pop(); if(!last) return; if(last.el?.parentNode){ last.el.parentNode.removeChild(last.el); if(this.selected===last.el) this._select(null); this.redoStack.push(last);} }
  redo(){ const next=this.redoStack.pop(); if(!next) return; if(next.el){ next.overlay.appendChild(next.el); this.history.push(next);} }

  _elSize(el){ return { w: el.offsetWidth, h: el.offsetHeight }; }
}
const ann = new Annotations(refs.container);

function scrollAnnoIntoView(el){
  if (!el) return;
  const wrap = el.closest('.page-wrap'); if (!wrap) return;
  const rectC = $('#pdf-container').getBoundingClientRect();
  const wrapR = wrap.getBoundingClientRect();
  const elCX = (wrapR.left - rectC.left + el.offsetLeft + el.offsetWidth/2) * zoom.scale;
  const elCY = (wrapR.top  - rectC.top  + el.offsetTop  + el.offsetHeight/2) * zoom.scale;
  const targetLeft = clamp(elCX - refs.scroll.clientWidth/2, 0, refs.scroll.scrollWidth);
  const targetTop  = clamp(elCY - refs.scroll.clientHeight/2, 0, refs.scroll.scrollHeight);
  refs.scroll.scrollTo({ left: targetLeft, top: targetTop, behavior: 'smooth' });
}

//// ---------- Signature ----------
class SigPad{
  constructor(canvas, modal){
    this.canvas=canvas; this.modal=modal; this.ctx=canvas.getContext('2d');
    this.clear(); this.drawing=false;
    const pos=ev=>{ const r=canvas.getBoundingClientRect(); const dpr=Math.max(1,devicePixelRatio||1); return {x:(ev.clientX-r.left)*dpr,y:(ev.clientY-r.top)*dpr}; };
    on(canvas,'pointerdown',e=>{ canvas.setPointerCapture?.(e.pointerId); this.drawing=true; const p=pos(e); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointermove',e=>{ if(!this.drawing) return; const p=pos(e); this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointerup',()=>{ this.drawing=false; });
  }
  open(){ this.modal.classList.add('show'); }
  close(){ this.modal.classList.remove('show'); }
  clear(){ const dpr=Math.max(1,devicePixelRatio||1); this.canvas.width=500*dpr; this.canvas.height=200*dpr; this.canvas.style.width='500px'; this.canvas.style.height='200px'; const c=this.ctx; c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,this.canvas.width,this.canvas.height); c.lineWidth=2.5*dpr; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round'; }
  dataURL(){ return this.canvas.toDataURL('image/png'); }
}
const sig = new SigPad(refs.sigPad, refs.sigModal);
class SigController{
  constructor(sig,ann){ this.sig=sig; this.ann=ann; }
  open(){ this.sig.open(); }
  close(){ this.sig.close(); }
  use(){ LAST_SIG_DATAURL=this.sig.dataURL(); this.close(); this.ann.setMode('sign'); toast('Signature ready — double‑tap/click to place'); }
}
const sigCtl = new SigController(sig, ann);
refs.sigModal?.classList.remove('show');

//// ---------- Render ----------
async function renderPdfFromFile(file, container, scale=1){
  const bytes = new Uint8Array(await file.arrayBuffer());
  CURRENT_PDF = { file, bytes, filename:file.name||'document.pdf', wraps:[], vpCSSByPage:[] };
  return renderPdfFromData(bytes, container, scale);
}
async function renderPdfFromData(bytes, container,