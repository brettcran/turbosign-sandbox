/* TurboSign — minimal stable ESM build
   - PDF.js v5 (CDN ESM) + module worker (robust cross-origin)
   - pdf-lib (ESM via +esm)
   - Only approved fixes: restore banner fit + overlay clip + stamp clamp
*/

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
const workerURL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.mjs';
try {
  // Reliable module worker; falls back to main thread if blocked.
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerURL, { type:'module' });
} catch (e) {
  console.warn('PDF.js module worker failed, falling back to main thread', e);
  pdfjsLib.GlobalWorkerOptions.workerPort = null;
}

import { PDFDocument, rgb, StandardFonts } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

const $ = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;

const refs = {
  scroll: $('#pdf-scroll'),
  container: $('#pdf-container'),
  fileInput: $('#file-input'),
  toolbar: $('#toolbar'),
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
  restoreBanner: $('#restore-banner'), restoreText: $('#restore-text'),
  restoreYes: $('#restore-yes'), restoreNo: $('#restore-no'),
};
const toast = (msg, kind='ok', t=2400) => {
  const n = $('#toast'); if (!n) return; n.textContent = msg; n.className=''; n.classList.add('show', kind);
  clearTimeout(n._t); n._t = setTimeout(()=>{ n.className=''; }, t);
};

let CURRENT_PDF = { file:null, bytes:null, filename:null, wraps:[], vpCSSByPage:[] };
let LAST_SIG_DATAURL = null;

/* ---------- zoom (centered pinch / ctrl+wheel) ---------- */
const zoom = {
  scale: 1, min: 0.6, max: 3, suspended:false,
  setScale(newScale, cx, cy){
    newScale = clamp(newScale, this.min, this.max);
    if (newScale === this.scale) return;

    const scroll = refs.scroll;
    const rect = scroll.getBoundingClientRect();

    const contentW0 = refs.container.scrollWidth * this.scale;
    const contentH0 = refs.container.scrollHeight * this.scale;
    const contentW1 = refs.container.scrollWidth * newScale;
    const contentH1 = refs.container.scrollHeight * newScale;

    const gx0 = Math.max(0, (scroll.clientWidth  - contentW0) / 2);
    const gy0 = Math.max(0, (scroll.clientHeight - contentH0) / 2);
    const gx1 = Math.max(0, (scroll.clientWidth  - contentW1) / 2);
    const gy1 = Math.max(0, (scroll.clientHeight - contentH1) / 2);

    const contentX = (scroll.scrollLeft + (cx - rect.left) - gx0) / this.scale;
    const contentY = (scroll.scrollTop  + (cy - rect.top ) - gy0) / this.scale;

    this.scale = newScale;
    refs.container.style.transformOrigin = '0 0';
    refs.container.style.transform = `scale(${this.scale})`;

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

// pointer pinch
(function wirePinch(){
  const pts = new Map(); let lastDist=0, cx=0, cy=0, pinching=false;

  const onPD = (e)=>{ if(zoom.suspended) return; pts.set(e.pointerId, e);
    if(pts.size===2){ const [a,b]=[...pts.values()]; lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; pinching=true; refs.scroll.style.touchAction='none'; } };
  const onPM = (e)=>{ if(!pts.has(e.pointerId)) return; pts.set(e.pointerId,e);
    if(pinching && pts.size===2){ const [a,b]=[...pts.values()]; const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; if(lastDist){ zoom.setScale(zoom.scale*(d/lastDist),cx,cy); } lastDist=d; e.preventDefault(); } };
  const onPU = (e)=>{ pts.delete(e.pointerId); if(pts.size<2){ pinching=false; lastDist=0; refs.scroll.style.touchAction='pan-y'; } };

  refs.scroll.addEventListener('pointerdown', onPD);
  refs.scroll.addEventListener('pointermove', onPM, {passive:false});
  refs.scroll.addEventListener('pointerup', onPU);
  refs.scroll.addEventListener('pointercancel', onPU);

  refs.scroll.addEventListener('wheel', (e)=>{ if(!(e.ctrlKey||e.metaKey)) return; e.preventDefault(); zoom.setScale(zoom.scale*(e.deltaY<0?1.1:0.9), e.clientX, e.clientY); }, {passive:false});
  const withinStage = el => !!el && (el===refs.scroll || el===refs.container || el.closest?.('#pdf-stage, #pdf-scroll, #pdf-container'));
  addEventListener('gesturestart',  e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gesturechange', e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gestureend',    e=>{ if(withinStage(e.target)) e.preventDefault(); }, {passive:false});
  refs.scroll.addEventListener('touchmove', (e)=>{ if(e.touches && e.touches.length>1) e.preventDefault(); }, {passive:false});
})();

function centerHorizontally(){
  const w = CURRENT_PDF.vpCSSByPage[0]?.width ||
            parseFloat(CURRENT_PDF.wraps[0]?.querySelector('canvas')?.style.width || '0');
  if(!w) return;
  const desired = Math.max(0, (w*zoom.scale - refs.scroll.clientWidth)/2);
  refs.scroll.scrollLeft = desired;
  const totalH = refs.container.scrollHeight * zoom.scale;
  if (totalH <= refs.scroll.clientHeight) refs.scroll.scrollTop = 0;
}
on(window,'resize', centerHorizontally);

/* ---------- annotations ---------- */
class Annotations{
  constructor(container){
    this.container=container; this.mode=null; this.overlays=[]; this.selected=null;
    this.history=[]; this.redoStack=[]; this.textStyle={ size:16, color:'#000', bold:false, italic:false, family:'Arial, sans-serif' };
    this.drag={ el:null, overlay:null, dx:0, dy:0 }; this.resize={ el:null, overlay:null, startW:0, startH:0, sx:0, sy:0 };
    on(document,'pointermove',e=>this._onMove(e),{passive:false});
    on(document,'pointerup',  e=>this._onUp(e));
  }
  setMode(m){
    this.mode=m;
    ['text','stamp','sign'].forEach(k=>document.querySelector(`[data-act="${k}"]`)?.classList.toggle('active', this.mode===k));
    this._select(null);
  }
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
          if (!LAST_SIG_DATAURL){ toast('Draw a signature first', 'err'); sigCtl.open(); return; }
          const {x,y}=this._pos(ov,e); const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5);
          this._select(el); scrollAnnoIntoView(el);
        }
      });

      if(isTouch){
        let t=0, lx=0, ly=0;
        on(ov,'pointerdown',e=>{
          if (e.pointerType!=='touch' || e.target!==ov) return;
          const now=performance.now(); const {x,y}=this._pos(ov,e);
          const dbl=(now-t<300 && Math.abs(x-lx)<24 && Math.abs(y-ly)<24); t=now; lx=x; ly=y;
          if(!dbl) return;
          if (this.mode==='text'){ this._addText(ov,x,y,true); }
          else if (this.mode==='sign'){ if(!LAST_SIG_DATAURL){ toast('Draw a signature first','err'); sigCtl.open(); return; } const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5); this._select(el); scrollAnnoIntoView(el); }
        }, {passive:true});
      }

      on(ov,'pointerdown', e=>{
        if(this.mode!=='stamp' || e.target!==ov) return;
        const {x,y}=this._pos(ov,e); this._addStamp(ov,x,y);
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
    const st=this.textStyle; el.style.color=st.color; el.style.fontSize=`${Math.max(16,st.size)}px`;
    el.style.fontWeight=st.bold?'700':'400'; el.style.fontStyle=st.italic?'italic':'normal'; el.style.fontFamily=st.family;
    overlay.appendChild(el); this._wireAnno(el, overlay, {resizable:false}); if(focus) this._focus(el);
    this._recordAdd(overlay, el);
  }

  _addStamp(overlay,x,y){
    const el=document.createElement('div'); el.className='anno stamp';
    el.innerHTML=`<svg viewBox="0 0 24 24"><path d="M4 12l4 4 12-12"/></svg>`;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    overlay.appendChild(el);
    requestAnimationFrame(()=>{
      const W=overlay.clientWidth, H=overlay.clientHeight;
      const ew=el.offsetWidth||22, eh=el.offsetHeight||22;
      const nx=clamp(x, 0, Math.max(0, W-ew));
      const ny=clamp(y, 0, Math.max(0, H-eh));
      if (nx!==x) el.style.left=nx+'px';
      if (ny!==y) el.style.top =ny+'px';
    });
    this._wireAnno(el, overlay, {resizable:false});
    this._recordAdd(overlay, el);
  }

  _addSignature(overlay,x,y,dataURL,widthHint){
    const el=document.createElement('div'); el.className='anno sign'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const img=new Image(); img.draggable=false; img.src=dataURL; img.style.display='block';
    el.appendChild(img); overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:true});
    img.onload=()=>{ const maxW=widthHint || Math.min(overlay.clientWidth*0.6, img.naturalWidth||img.width||300); img.style.width=maxW+'px'; img.style.height='auto'; scrollAnnoIntoView(el); };
    this._recordAdd(overlay, el); return el;
  }

  _wireAnno(el, overlay, {resizable}){
    const startDrag=(e)=>{ if(el.classList.contains('text') && document.activeElement===el){ this._select(el); return; }
      const {x,y}=this._pos(overlay,e); const left=parseFloat(el.style.left)||0, top=parseFloat(el.style.top)||0;
      this.drag={ el, overlay, dx:x-left, dy:y-top }; $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true; el.setPointerCapture?.(e.pointerId); this._select(el); e.preventDefault(); };
    on(el,'pointerdown', startDrag, {passive:false});
    const innerImg=el.querySelector('img'); if(innerImg) on(innerImg,'pointerdown', startDrag, {passive:false});

    if(el.classList.contains('text')){ on(el,'dblclick',()=>{ this._focus(el); this._select(el); }); on(el,'input',()=>{}); }

    if(resizable && !el.classList.contains('text')){
      const h=document.createElement('div'); h.className='handle br';
      Object.assign(h.style,{ position:'absolute', right:'-8px', bottom:'-8px', width:'14px', height:'14px', background:'#fff', border:'2px solid #4ea3ff', borderRadius:'3px', cursor:'nwse-resize', touchAction:'none' });
      el.appendChild(h);
      on(h,'pointerdown',e=>{ e.stopPropagation(); const { w, h:hh } = this._elSize(el); this.resize={ el, overlay, startW:w, startH:hh, sx:e.clientX, sy:e.clientY }; $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true; h.setPointerCapture?.(e.pointerId