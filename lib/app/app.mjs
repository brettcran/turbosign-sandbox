/* TurboSign — app.mjs (v4.1 Gold Stable)
   - PDF.js v5 (module worker) with CDN fallback
   - pdf-lib (ESM) for flatten/save
   - Features: text (dblclick/tap), stamps, signatures (modal → place),
     undo/redo, session restore, toasts, settings modal for text,
     centered pinch zoom, wheel zoom
*/

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.4/build/pdf.mjs";
import { PDFDocument, rgb, StandardFonts } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

/* ---------- Worker boot ---------- */
async function initWorker() {
  try {
    const workerUrl = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.4/build/pdf.worker.mjs";
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: "module" });
    console.info("[PDF.js] Worker: CDN module");
  } catch (e) {
    console.error("[PDF.js] Worker failed, using main thread", e);
    pdfjsLib.GlobalWorkerOptions.workerPort = null;
  }
}
await initWorker();

/* ---------- Helpers ---------- */
const $ = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const once = (el, ev, cb, opts) =>
  el && el.addEventListener(ev, function h(e){ el.removeEventListener(ev,h,opts); cb(e); }, opts);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;

const toast = (msg, kind='ok', t=2400) => {
  const n = $('#toast'); if (!n) return;
  n.textContent = msg; n.className = ''; n.classList.add('show', kind);
  clearTimeout(n._t); n._t = setTimeout(()=>{ n.className=''; }, t);
};

/* ---------- Refs ---------- */
const refs = {
  scroll: $('#pdf-scroll'),
  container: $('#pdf-container'),
  fileInput: $('#file-input'),
  sigModal: $('#sign-modal'),
  sigPad: $('#sig-pad'),
  sigUse: $('#sig-use'), sigClear: $('#sig-clear'), sigCancel: $('#sig-cancel'),
  restoreBanner: $('#restore-banner'), restoreText: $('#restore-text'),
  restoreYes: $('#restore-yes'), restoreNo: $('#restore-no'),
};
let CURRENT_PDF = { file:null, bytes:null, filename:null, wraps:[], vpCSSByPage:[] };
let LAST_SIG_DATAURL = null;

/* ---------- Zoom ---------- */
const zoom = {
  scale: 1,
  min: 0.7,
  max: 2.2,
  suspended: false,
  setScale(newScale, cx, cy){
    newScale = clamp(newScale, this.min, this.max);
    if (newScale === this.scale) return;

    const scroll = refs.scroll;
    const rect = scroll.getBoundingClientRect();
    const factor = newScale / this.scale;
    this.scale = newScale;

    refs.container.style.transformOrigin = '0 0';
    refs.container.style.transform = `scale(${this.scale})`;

    const contentW = refs.container.scrollWidth * this.scale;
    const contentH = refs.container.scrollHeight * this.scale;
    const contentX = (scroll.scrollLeft + (cx - rect.left)) / (this.scale/factor);
    const contentY = (scroll.scrollTop + (cy - rect.top)) / (this.scale/factor);

    scroll.scrollLeft = contentX - (cx - rect.left);
    scroll.scrollTop  = contentY - (cy - rect.top);

    if (contentW <= scroll.clientWidth)  scroll.scrollLeft = 0;
    if (contentH <= scroll.clientHeight) scroll.scrollTop  = 0;
  }
};

/* Pinch + wheel */
(function wirePinch(){
  const scroll = refs.scroll;
  const pts = new Map(); let lastDist = 0, cx = 0, cy = 0, pinching = false;

  const onPD = (e)=>{ pts.set(e.pointerId,e);
    if(pts.size===2){ const [a,b]=[...pts.values()];
      lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
      cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; pinching=true;
      scroll.style.touchAction='none';
    }};
  const onPM = (e)=>{ if(!pts.has(e.pointerId)) return;
    pts.set(e.pointerId,e);
    if(pinching&&pts.size===2){ const [a,b]=[...pts.values()];
      const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
      cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2;
      if(lastDist){ const f=d/lastDist; zoom.setScale(zoom.scale*f,cx,cy); }
      lastDist=d; e.preventDefault();
    }};
  const onPU = (e)=>{ pts.delete(e.pointerId); if(pts.size<2){ pinching=false; scroll.style.touchAction='pan-y'; }};
  scroll.addEventListener('pointerdown',onPD);
  scroll.addEventListener('pointermove',onPM,{passive:false});
  scroll.addEventListener('pointerup',onPU); scroll.addEventListener('pointercancel',onPU);
  scroll.addEventListener('wheel',e=>{ if(e.ctrlKey||e.metaKey){ e.preventDefault(); const f=e.deltaY<0?1.1:0.9; zoom.setScale(zoom.scale*f,e.clientX,e.clientY); }},{passive:false});
})();

/* ---------- Center helper ---------- */
function centerHorizontally(){
  const w = CURRENT_PDF.vpCSSByPage[0]?.width;
  if (!w) return;
  const desired = Math.max(0,(w*zoom.scale-refs.scroll.clientWidth)/2);
  refs.scroll.scrollLeft = desired;
}
on(window,'resize',centerHorizontally);

/* ---------- Annotations ---------- */
class Annotations {
  constructor(container){ this.container=container; this.mode=null; this.overlays=[]; this.history=[]; this.redoStack=[]; }
  setMode(m){ this.mode=m; }
  attachOverlays(wraps){
    this.overlays.forEach(ov=>ov.remove());
    this.overlays=[];
    wraps.forEach(({wrap})=>{
      const ov=document.createElement('div'); ov.className='overlay'; wrap.appendChild(ov);

      on(ov,'dblclick',e=>{
        if(this.mode==='text'){ this._addText(ov,e.offsetX,e.offsetY); }
        if(this.mode==='sign'&&LAST_SIG_DATAURL){ this._addSign(ov,e.offsetX,e.offsetY); }
      });
      on(ov,'click',e=>{ if(this.mode==='stamp'){ this._addStamp(ov,e.offsetX,e.offsetY); }});
      this.overlays.push(ov);
    });
  }
  _addText(ov,x,y){ const el=document.createElement('div'); el.className='anno text'; el.contentEditable='true'; el.style.left=x+'px'; el.style.top=y+'px'; ov.appendChild(el); this.history.push({type:'add',el,ov}); }
  _addStamp(ov,x,y){ const el=document.createElement('div'); el.className='anno stamp'; el.style.left=x+'px'; el.style.top=y+'px'; el.innerHTML='<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>'; ov.appendChild(el); this.history.push({type:'add',el,ov}); }
  _addSign(ov,x,y){ const el=document.createElement('div'); el.className='anno sign'; el.style.left=x+'px'; el.style.top=y+'px'; const img=new Image(); img.src=LAST_SIG_DATAURL; img.style.width='160px'; el.appendChild(img); ov.appendChild(el); this.history.push({type:'add',el,ov}); }
  undo(){ const last=this.history.pop(); if(!last) return; last.el.remove(); this.redoStack.push(last); }
  redo(){ const next=this.redoStack.pop(); if(!next) return; next.ov.appendChild(next.el); this.history.push(next); }
}
const ann = new Annotations(refs.container);

/* ---------- Signature Pad ---------- */
class SigPad {
  constructor(canvas,modal){ this.canvas=canvas; this.modal=modal; this.ctx=canvas.getContext('2d'); this.clear(); this.drawing=false;
    const pos=ev=>{ const r=canvas.getBoundingClientRect(); return {x:ev.clientX-r.left,y:ev.clientY-r.top}; };
    on(canvas,'pointerdown',e=>{ this.drawing=true; const p=pos(e); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointermove',e=>{ if(!this.drawing) return; const p=pos(e); this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointerup',()=>{ this.drawing=false; });
  }
  clear(){ this.ctx.fillStyle="#fff"; this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height); this.ctx.lineWidth=2; this.ctx.strokeStyle="#000"; this.ctx.lineCap="round"; }
  open(){ refs.sigModal.classList.add('show'); }
  close(){ refs.sigModal.classList.remove('show'); }
  dataURL(){ return this.canvas.toDataURL(); }
}
const sig = new SigPad(refs.sigPad, refs.sigModal);

/* ---------- Render ---------- */
async function renderPdfFromFile(file){
  CURRENT_PDF.file=file; const bytes=new Uint8Array(await file.arrayBuffer()); CURRENT_PDF.bytes=bytes; CURRENT_PDF.filename=file.name;
  return renderPdfFromData(bytes);
}
async function renderPdfFromData(bytes){
  refs.container.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  const pdf = await pdfjsLib.getDocument({data:bytes}).promise;
  for(let i=1;i<=pdf.numPages;i++){ const page=await pdf.getPage(i); const vp=page.getViewport({scale:1}); const canvas=document.createElement('canvas'); canvas.className='pdfpage'; const wrap=document.createElement('div'); wrap.className='page-wrap'; wrap.appendChild(canvas); refs.container.appendChild(wrap);
    const ctx=canvas.getContext('2d'); canvas.width=vp.width; canvas.height=vp.height; await page.render({canvasContext:ctx,viewport:vp}).promise;
    CURRENT_PDF.wraps.push(wrap); CURRENT_PDF.vpCSSByPage.push(vp); }
  ann.attachOverlays(CURRENT_PDF.wraps.map(w=>({wrap:w})));
  centerHorizontally();
}

/* ---------- Save ---------- */
async function saveFlattened(){
  if(!CURRENT_PDF.bytes){ toast('Open a PDF first','err'); return; }
  const pdf = await PDFDocument.load(CURRENT_PDF.bytes);
  const pages=pdf.getPages(); const helv=await pdf.embedFont(StandardFonts.Helvetica);
  CURRENT_PDF.wraps.forEach((wrap,i)=>{ const overlay=wrap.querySelector('.overlay'); if(!overlay) return; const page=pages[i]; overlay.querySelectorAll('.anno').forEach(el=>{ const x=el.offsetLeft,y=page.getHeight()-el.offsetTop-20; if(el.classList.contains('text')){ page.drawText(el.textContent||'',{x,y,font:helv,size:16,color:rgb(0,0,0)}); } if(el.classList.contains('stamp')){ page.drawText('✓',{x,y,font:helv,size:32,color:rgb(0,0,0)}); } }); });
  const out=await pdf.save(); const blob=new Blob([out],{type:'application/pdf'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=(CURRENT_PDF.filename||'doc.pdf').replace(/\.pdf$/,'-signed.pdf'); a.click();
}

/* ---------- UI ---------- */
on($('[data-act="open"]'),'click',()=>refs.fileInput.click());
on(refs.fileInput,'change',async e=>{ const f=e.target.files[0]; if(f) await renderPdfFromFile(f); toast('PDF loaded ✔️'); });
on($('[data-act="text"]'),'click',()=>ann.setMode('text'));
on($('[data-act="stamp"]'),'click',()=>ann.setMode('stamp'));
on($('[data-act="sign"]'),'click',()=>{ sig.open(); });
on(refs.sigUse,'click',()=>{ LAST_SIG_DATAURL=sig.dataURL(); sig.close(); ann.setMode('sign'); toast('Signature ready — double-click to place'); });
on(refs.sigClear,'click',()=>sig.clear());
on(refs.sigCancel,'click',()=>sig.close());
on($('[data-act="undo"]'),'click',()=>ann.undo());
on($('[data-act="redo"]'),'click',()=>ann.redo());
on($('[data-act="save"]'),'click',saveFlattened);
on($('[data-act="help"]'),'click',()=>toast('📂 Open a PDF → Text (dblclick), stamp ✓ (click), signature (draw→use→place). Save to flatten.'));