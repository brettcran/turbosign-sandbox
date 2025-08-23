/* TurboSign — app.mjs (iOS page-zoom off, centered pinch, toolbar stable) */

//// Utils
const $ = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const once = (el, ev, cb, opts) => el && el.addEventListener(ev, function h(e){ el.removeEventListener(ev, h, opts); cb(e); }, opts);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const toast = (msg, kind='ok', t=2600) => { const n=$('#toast'); if(!n) return; n.textContent=msg; n.className=''; n.classList.add('show',kind); clearTimeout(n._t); n._t=setTimeout(()=>n.className='',t); };
async function headOK(url){ try{ const r=await fetch(url,{method:'HEAD',cache:'no-store'}); return r.ok; }catch{ return false; } }
function isValidPdfBytes(bytes){ if(!bytes||!bytes.length) return false; for(let i=0;i<8&&i+4<bytes.length;i++){ if(bytes[i]===0x25&&bytes[i+1]===0x50&&bytes[i+2]===0x44&&bytes[i+3]===0x46&&bytes[i+4]===0x2D) return true; } return false; }

//// PDF.js (ESM v5) with fallbacks
let pdfjsLib;
const CDN_VER='5.4.54', CDN_BASE=`https://cdn.jsdelivr.net/npm/pdfjs-dist@${CDN_VER}/build/`;
async function loadPdfJs(){
  const localCore = new URL('../build/pdf.mjs', import.meta.url).href;
  pdfjsLib = (await headOK(localCore)) ? await import(localCore) : await import(CDN_BASE+'pdf.mjs');
  try{
    const localW = new URL('../build/pdf.worker.mjs', import.meta.url).href;
    if (await headOK(localW)) { const t=new Worker(localW,{type:'module'}); t.terminate(); pdfjsLib.GlobalWorkerOptions.workerPort=new Worker(localW,{type:'module'}); return; }
  }catch{}
  try{
    const cdnW = CDN_BASE+'pdf.worker.mjs';
    if (await headOK(cdnW)) { const t=new Worker(cdnW,{type:'module'}); t.terminate(); pdfjsLib.GlobalWorkerOptions.workerPort=new Worker(cdnW,{type:'module'}); return; }
  }catch{}
  pdfjsLib.GlobalWorkerOptions.workerPort=null; // main thread fallback
}
import { PDFDocument, rgb, StandardFonts } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';
await loadPdfJs();

//// Refs & state
const refs = {
  scroll: $('#pdf-scroll'), container: $('#pdf-container'), fileInput: $('#file-input'),
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

/* ----------------------------------------------------------------
   STOP SAFARI PAGE‑LEVEL PINCH + DOUBLE‑TAP ZOOM EVERYWHERE
----------------------------------------------------------------- */
const withinApp = (el)=> !!el && (el===document.body || el.closest?.('#toolbar, #pdf-stage, #pdf-scroll, #pdf-container, .modal'));
addEventListener('gesturestart',  e=>{ if(withinApp(e.target)) e.preventDefault(); }, {passive:false});
addEventListener('gesturechange', e=>{ if(withinApp(e.target)) e.preventDefault(); }, {passive:false});
addEventListener('gestureend',    e=>{ if(withinApp(e.target)) e.preventDefault(); }, {passive:false});
// If two or more touches move anywhere in app, stop default (page pinch)
document.addEventListener('touchmove', (e)=>{ if(withinApp(e.target) && e.touches?.length>1) e.preventDefault(); }, {passive:false});
// Also neutralize double‑tap zoom heuristics
let lastTap=0; document.addEventListener('touchend',(e)=>{ const now=performance.now(); if(withinApp(e.target)&&now-lastTap<280){ e.preventDefault(); } lastTap=now; }, {passive:false});

/* ----------------------------------------------------------------
   Centered pinch zoom — computes from base layout, no drift
----------------------------------------------------------------- */
const zoom = {
  scale: 1, min:0.6, max:3, suspended:false,
  // base logical content size (unscaled)
  baseW: 1, baseH: 1,

  setBaseFromLayout(){
    // width = max page width; height = sum of page heights + gaps + container padding
    let w = 0, h = 0;
    CURRENT_PDF.vpCSSByPage.forEach((vp, i)=>{ w = Math.max(w, vp.width); h += vp.height; if (i>0) h += 12; });
    // container paddings (top + bottom)
    h += 20 + (140); // matches CSS padding 20 top, 140 bottom approx
    this.baseW = Math.max(1, w);
    this.baseH = Math.max(1, h);
  },

  setScale(newScale, cx, cy){
    newScale = clamp(newScale, this.min, this.max);
    if (newScale === this.scale) return;

    const scroll = refs.scroll;
    const rect   = scroll.getBoundingClientRect();
    const factor = newScale / this.scale;

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

// pointer/trackpad pinch
(function wirePinch(){
  const pts = new Map(); let lastDist=0, cx=0, cy=0, pinching=false;

  const down = (e)=>{ if(zoom.suspended) return; pts.set(e.pointerId,e);
    if(pts.size===2){ const [a,b]=[...pts.values()]; lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; pinching=true; refs.scroll.style.touchAction='none'; } };
  const move = (e)=>{ if(!pts.has(e.pointerId)) return; pts.set(e.pointerId,e);
    if(pinching && pts.size===2){ const [a,b]=[...pts.values()]; const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; if(lastDist){ zoom.setScale(zoom.scale*(d/lastDist),cx,cy); } lastDist=d; e.preventDefault(); } };
  const up = (e)=>{ pts.delete(e.pointerId); if(pts.size<2){ pinching=false; lastDist=0; refs.scroll.style.touchAction='pan-y'; } };

  refs.scroll.addEventListener('pointerdown', down);
  refs.scroll.addEventListener('pointermove', move, {passive:false});
  refs.scroll.addEventListener('pointerup', up);
  refs.scroll.addEventListener('pointercancel', up);

  // Ctrl/⌘ + wheel zoom (trackpads)
  refs.scroll.addEventListener('wheel', (e)=>{ if(!(e.ctrlKey||e.metaKey)) return; e.preventDefault();
    zoom.setScale(zoom.scale*(e.deltaY<0?1.1:0.9), e.clientX, e.clientY);
  }, {passive:false});
})();

function centerHorizontally(){
  const w = zoom.baseW;
  const desired = Math.max(0, (w*zoom.scale - refs.scroll.clientWidth)/2);
  refs.scroll.scrollLeft = desired;
  const totalH = zoom.baseH * zoom.scale;
  if (totalH <= refs.scroll.clientHeight) refs.scroll.scrollTop = 0;
}
on(window,'resize', centerHorizontally);

//// Annotations (same behavior as your working build)
class Annotations{
  constructor(container){
    this.container=container; this.mode=null; this.overlays=[]; this.selected=null;
    this.history=[]; this.redoStack=[]; this.textStyle={ size:16, color:'#000', bold:false, italic:false, family:'Arial, sans-serif' };
    this.drag={ el:null, overlay:null, dx:0, dy:0 }; this.resize={ el:null, overlay:null, startW:0, startH:0, sx:0, sy:0 };
    on(document,'pointermove',e=>this._onMove(e),{passive:false}); on(document,'pointerup',  e=>this._onUp(e));
  }
  setMode(m){ this.mode=m; ['text','stamp','sign'].forEach(k=>document.querySelector(`[data-act="${k}"]`)?.classList.toggle('active', this.mode===k)); this._select(null); }
  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove()); this.overlays=[];
    wrapInfos.forEach(({wrap})=>{
      const ov=document.createElement('div'); ov.className='overlay'; wrap.appendChild(ov);
      on(ov,'pointerdown', e=>{ if(e.target===ov) this._select(null); }, {passive:true});

      on(ov,'dblclick', e=>{
        if (e.target!==ov) return;
        if (this.mode==='text'){ const {x,y}=this._pos(ov,e); this._addText(ov,x,y,true); }
        else if (this.mode==='sign'){ if(!LAST_SIG_DATAURL){ toast('Draw a signature first','err'); sigCtl.open(); return; }
          const {x,y}=this._pos(ov,e); const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5); this._select(el); scrollAnnoIntoView(el); }
      });

      // mobile double‑tap
      let t=0,lx=0,ly=0;
      on(ov,'pointerdown', e=>{
        if(e.pointerType!=='touch'||e.target!==ov) return;
        const now=performance.now(); const {x,y}=this._pos(ov,e); const dbl=(now-t<300 && Math.abs(x-lx)<24 && Math.abs(y-ly)<24); t=now; lx=x; ly=y;
        if(!dbl) return;
        if (this.mode==='text'){ this._addText(ov,x,y,true); }
        else if (this.mode==='sign'){ if(!LAST_SIG_DATAURL){ toast('Draw a signature first','err'); sigCtl.open(); return; }
          const el=this._addSignature(ov,x,y,LAST_SIG_DATAURL, ov.clientWidth*0.5); this._select(el); scrollAnnoIntoView(el); }
      }, {passive:true});

      // stamp single tap
      on(ov,'pointerdown', e=>{ if(this.mode!=='stamp' || e.target!==ov) return; const {x,y}=this._pos(ov,e); this._addStamp(ov,x,y); }, {passive:true});

      this.overlays.push(ov);
    });
  }
  _pos(overlay,e){ const r=overlay.getBoundingClientRect(); return { x:(e.clientX-r.left)/zoom.scale, y:(e.clientY-r.top)/zoom.scale }; }
  _elSize(el){ return { w:el.offsetWidth, h:el.offsetHeight }; }
  _addText(ov,x,y,focus){ const el=document.createElement('div'); el.className='anno text'; el.contentEditable='true'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const st=this.textStyle; el.style.color=st.color; el.style.fontSize=`${Math.max(16,st.size)}px`; el.style.fontWeight=st.bold?'700':'400'; el.style.fontStyle=st.italic?'italic':'normal'; el.style.fontFamily=st.family;
    ov.appendChild(el); this._wireAnno(el,ov,{resizable:false}); if(focus) this._focus(el); this._recordAdd(ov,el); }
  _addStamp(ov,x,y){ const el=document.createElement('div'); el.className='anno stamp'; el.style.left=`${x}px`; el.style.top=`${y}px`; el.innerHTML=`<svg viewBox="0 0 24 24"><path d="M4 12l4 4 12-12"/></svg>`; ov.appendChild(el); this._wireAnno(el,ov,{resizable:false}); this._recordAdd(ov,el); }
  _addSignature(ov,x,y,src,wh){ const el=document.createElement('div'); el.className='anno sign'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const img=new Image(); img.draggable=false; img.src=src; img.style.display='block';
    el.appendChild(img); ov.appendChild(el); this._wireAnno(el,ov,{resizable:true});
    img.onload=()=>{ const maxW=wh||Math.min(ov.clientWidth*0.6,img.naturalWidth||img.width||300); img.style.width=maxW+'px'; img.style.height='auto'; scrollAnnoIntoView(el); };
    this._recordAdd(ov,el); return el; }
  _wireAnno(el,ov,{resizable}){ const start=(e)=>{ if(el.classList.contains('text')&&document.activeElement===el){ this._select(el); return; }
      const {x,y}=this._pos(ov,e); const L=parseFloat(el.style.left)||0, T=parseFloat(el.style.top)||0; this.drag={el,overlay:ov,dx:x-L,dy:y-T}; $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true; el.setPointerCapture?.(e.pointerId); this._select(el); e.preventDefault(); };
    on(el,'pointerdown',start,{passive:false}); const inner=el.querySelector('img'); if(inner) on(inner,'pointerdown',start,{passive:false});
    if(el.classList.contains('text')) on(el,'dblclick',()=>{ this._focus(el); this._select(el); });
    if(resizable && !el.classList.contains('text')){ const h=document.createElement('div'); h.className='handle br';
      Object.assign(h.style,{position:'absolute',right:'-8px',bottom:'-8px',width:'14px',height:'14px',background:'#fff',border:'2px solid #4ea3ff',borderRadius:'3px',cursor:'nwse-resize',touchAction:'none'});
      el.appendChild(h); on(h,'pointerdown',e=>{ e.stopPropagation(); const {w,h:hh}=this._elSize(el); this.resize={el,overlay:ov,startW:w,startH:hh,sx:e.clientX,sy:e.clientY}; $('#pdf-scroll').style.touchAction='none'; zoom.suspended=true; h.setPointerCapture?.(e.pointerId); },{passive:false}); }
  }
  _onMove(e){ if(this.drag.el){ const {x,y}=this._pos(this.drag.overlay,e); let nx=x-this.drag.dx, ny=y-this.drag.dy;
      const W=this.drag.overlay.clientWidth,H=this.drag.overlay.clientHeight; const {w:ew,h:eh}=this._elSize(this.drag.el);
      nx=Math.max(0,Math.min(nx,W-ew)); ny=Math.max(0,Math.min(ny,H-eh)); this.drag.el.style.left=`${nx}px`; this.drag.el.style.top=`${ny}px`; e.preventDefault(); return; }
    if(this.resize.el){ const dx=(e.clientX-this.resize.sx)/zoom.scale; const w=Math.max(24,this.resize.startW+dx); const img=this.resize.el.querySelector('img'); if(img){ img.style.width=w+'px'; img.style.height='auto'; } e.preventDefault(); } }
  _onUp(e){ if(this.drag.el){ try{this.drag.el.releasePointerCapture?.(e.pointerId)}catch{}; this.drag={el:null,overlay:null,dx:0,dy:0}; }
    if(this.resize.el){ try{this.resize.el.releasePointerCapture?.(e.pointerId)}catch{}; this.resize={el:null,overlay:null,startW:0,startH:0,sx:0,sy:0}; }
    $('#pdf-scroll').style.touchAction='pan-y'; zoom.suspended=false; }
  _focus(el){ el.focus(); const sel=getSelection(); const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
  _select(el){ this.container.querySelectorAll('.anno').forEach(n=>n.classList.remove('selected')); this.selected=el; if(el) el.classList.add('selected'); }
  _recordAdd(ov,el){ this.history.push({type:'add',overlay:ov,el}); this.redoStack.length=0; }
  undo(){ const a=this.history.pop(); if(!a) return; if(a.el?.parentNode){ a.el.parentNode.removeChild(a.el); if(this.selected===a.el)this._select(null); this.redoStack.push(a);} }
  redo(){ const n=this.redoStack.pop(); if(!n)return; if(n.el){ n.overlay.appendChild(n.el); this.history.push(n);} }
}
const ann = new Annotations(refs.container);
function scrollAnnoIntoView(el){
  if(!el) return; const wrap=el.closest('.page-wrap'); if(!wrap) return;
  const rectC=$('#pdf-container').getBoundingClientRect(); const wrapR=wrap.getBoundingClientRect();
  const elCX=(wrapR.left-rectC.left+el.offsetLeft+el.offsetWidth/2)*zoom.scale;
  const elCY=(wrapR.top -rectC.top +el.offsetTop +el.offsetHeight/2)*zoom.scale;
  const targetLeft = clamp(elCX - refs.scroll.clientWidth/2, 0, refs.scroll.scrollWidth);
  const targetTop  = clamp(elCY - refs.scroll.clientHeight/2,0, refs.scroll.scrollHeight);
  refs.scroll.scrollTo({left:targetLeft, top:targetTop, behavior:'smooth'});
}

//// Signature
class SigPad{
  constructor(canvas, modal){ this.canvas=canvas; this.modal=modal; this.ctx=canvas.getContext('2d'); this.clear(); this.drawing=false;
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
const sigCtl = new (class { constructor(sig,ann){ this.sig=sig; this.ann=ann; } open(){ this.sig.open(); } close(){ this.sig.close(); } use(){ LAST_SIG_DATAURL=this.sig.dataURL(); this.close(); this.ann.setMode('sign'); toast('Signature ready — double‑tap/click to place'); } })(sig, ann);
refs.sigModal?.classList.remove('show');

//// Render
async function renderPdfFromFile(file, container, scale=1){
  const bytes=new Uint8Array(await file.arrayBuffer());
  CURRENT_PDF={ file, bytes, filename:file.name||'document.pdf', wraps:[], vpCSSByPage:[] };
  return renderPdfFromData(bytes, container, scale);
}
async function renderPdfFromData(bytes, container, scale=1){
  if(!isValidPdfBytes(bytes)){ toast('That file doesn’t look like a PDF','err'); throw new Error('Invalid PDF'); }
  container.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  let pdf;
  try{ pdf=await pdfjsLib.getDocument({ data:bytes }).promise; }
  catch(err){ console.error(err); toast('Could not open PDF','err',3600); throw err; }

  const ratio=Math.max(1,Math.min(2,devicePixelRatio||1));
  for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);
    const vpCSS=page.getViewport({scale}); const vpDev=page.getViewport({scale:scale*ratio});
    const wrap=document.createElement('div'); wrap.className='page-wrap';
    const canvas=document.createElement('canvas'); canvas.className='pdfpage';
    canvas.width=Math.floor(vpDev.width); canvas.height=Math.floor(vpDev.height);
    canvas.style.width=vpCSS.width+'px'; canvas.style.height=vpCSS.height+'px';
    wrap.appendChild(canvas); container.appendChild(wrap);
    const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
    await page.render({canvasContext:ctx, viewport:vpDev, intent:'display'}).promise;
    CURRENT_PDF.wraps.push(wrap); CURRENT_PDF.vpCSSByPage.push({width:vpCSS.width,height:vpCSS.height});
  }
  ann.attachOverlays(CURRENT_PDF.wraps.map((wrap,i)=>({wrap,vpCSS:CURRENT_PDF.vpCSSByPage[i]})));
  zoom.setBaseFromLayout();
  requestAnimationFrame(()=>{ centerHorizontally(); });
}

//// Save (flatten) — unchanged behavior
async function saveFlattened(){
  if (!CURRENT_PDF.bytes){ toast('Open a PDF first','err'); return; }
  try{
    const pdf  = await PDFDocument.load(CURRENT_PDF.bytes);
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const helvB= await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages= pdf.getPages(); const ops=[];
    CURRENT_PDF.wraps.forEach((wrap, idx)=>{
      const overlay=wrap.querySelector('.overlay'); if(!overlay) return;
      const page=pages[idx]; const pageW=page.getWidth(), pageH=page.getHeight();
      const vp=CURRENT_PDF.vpCSSByPage[idx]; const fx=pageW/vp.width, fy=pageH/vp.height;

      overlay.querySelectorAll('.anno').forEach(el=>{
        const left=el.offsetLeft, top=el.offsetTop, w=el.offsetWidth, h=el.offsetHeight;
        const x=left*fx, y=pageH-(top+h)*fy;

        if(el.classList.contains('text')){
          const cs=getComputedStyle(el); const size=(parseFloat(cs.fontSize)||16)*fx;
          const [rr,gg,bb]=(cs.color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
          const font=(parseInt(cs.fontWeight,10)||400)>=600?helvB:helv;
          page.drawText(el.textContent||'',{x,y,size,font,color:rgb(rr,gg,bb)});
        }else if(el.classList.contains('stamp')){
          const stroke=rgb(0,0,0); const x1=x, y1=y+h*fy*0.45, x2=x+w*fx*0.35, y2=y+h*fy*0.15, x3=x+w*fx, y3=y+h*fy*0.85;
          page.drawLine({start:{x:x1,y:y1},end:{x:x2,y:y2},thickness:2*fx,color:stroke});
          page.drawLine({start:{x:x2,y:y2},end:{x:x3,y:y3},thickness:2*fx,color:stroke});
        }else{
          const img=el.querySelector('img'); if(!img) return;
          ops.push((async()=>{ try{
              let bytes; if(img.src.startsWith('data:')){ const b64=(img.src.split(',')[1]||''); const bin=atob(b64); bytes=new Uint8Array(bin.length); for(let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i); }
              else{ const res=await fetch(img.src,{mode:'cors'}); bytes=new Uint8Array(await res.arrayBuffer()); }
              const png=await pdf.embedPng(bytes); page.drawImage(png,{x,y,width:w*fx,height:h*fy});
          }catch(e){ console.warn('Embed image failed',e); }})());
        }
      });
    });
    if(ops.length) await Promise.all(ops);
    const out=await pdf.save(); const defaultName=(CURRENT_PDF.filename||'document.pdf').replace(/\.pdf$/i,'')+'-signed.pdf';
    if('showSaveFilePicker' in window){ try{ const handle=await window.showSaveFilePicker({suggestedName:defaultName,types:[{description:'PDF',accept:{'application/pdf':['.pdf']}}]}); const w=await handle.createWritable(); await w.write(out); await w.close(); toast('Saved ✔️'); return; }catch{} }
    const blob=new Blob([out],{type:'application/pdf'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=defaultName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1200); toast('Downloaded ✔️');
  }catch(e){ console.error('Save failed',e); toast('Could not save PDF','err'); }
}

//// UI wiring
function wireUI(){
  on(refs.openBtn,'click',()=>refs.fileInput?.click());
  on(refs.fileInput,'change',async e=>{ const file=e.target.files?.[0]; if(!file) return;
    try{ await renderPdfFromFile(file, refs.container, 1); toast('PDF loaded ✔️'); }catch{} });
  on(refs.textBtn,'click',()=>{ ann.setMode(ann.mode==='text'?null:'text'); toast(ann.mode?'Text: double‑tap/click':'Tool off'); });
  on(refs.stampBtn,'click',()=>{ ann.setMode(ann.mode==='stamp'?null:'stamp'); toast(ann.mode?'Stamp: tap/click':'Tool off'); });
  on(refs.signBtn,'click',()=>sigCtl.open());
  on(refs.undoBtn,'click',()=>ann.undo());
  on(refs.redoBtn,'click',()=>ann.redo());
  on(refs.helpBtn,'click',()=>toast('Open → double‑tap Text or Signature (draw first) → Save. Drag to move.','ok',4200));
  on(refs.saveBtn,'click',saveFlattened);
  on(refs.sigUse,'click',e=>{ e.stopPropagation(); sigCtl.use(); });
  on(refs.sigClear,'click',e=>{ e.stopPropagation(); sig.clear(); });
  on(refs.sigCancel,'click',e=>{ e.stopPropagation(); sigCtl.close(); });
}
wireUI();

// quiet benign rejections
addEventListener('unhandledrejection',ev=>{ const m=String(ev.reason?.message||ev.reason||''); if(m.includes('Rendering cancelled')||m.includes('AbortError')) ev.preventDefault(); });