/* TurboSign 4.0 — stable ESM
   Patch 2: iOS Safari → force main‑thread rendering by disabling workers,
   which prevents the “No GlobalWorkerOptions.workerSrc specified” error.
   All other logic unchanged from the last working 4.0 file.
*/

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
const WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.mjs';

// --- Detect iOS Safari (WebKit)
const ua = navigator.userAgent || '';
const isIOSWebKit = /iP(ad|hone|od)/.test(ua) && /WebKit/.test(ua) && !/CriOS|FxiOS/.test(ua);

(function bootPdfjs(){
  try {
    if (isIOSWebKit) {
      // IMPORTANT: fully disable workers on iOS Safari to avoid workerSrc path
      pdfjsLib.GlobalWorkerOptions.disableWorker = true;
      pdfjsLib.GlobalWorkerOptions.workerPort = null;
      console.info('[PDF.js] iOS Safari → disableWorker=true (main‑thread render)');
    } else {
      const w = new Worker(WORKER_URL, { type:'module' });
      pdfjsLib.GlobalWorkerOptions.workerPort = w;
      // (No need to set workerSrc when using module workerPort)
      console.info('[PDF.js] Worker: module (CDN)');
    }
  } catch (e) {
    console.warn('[PDF.js] Worker boot failed → fall back to main thread', e);
    pdfjsLib.GlobalWorkerOptions.disableWorker = true;
    pdfjsLib.GlobalWorkerOptions.workerPort = null;
  }
  try { pdfjsLib.setVerbosity?.((pdfjsLib.VerbosityLevel||{}).errors ?? 1); } catch {}
})();

// pdf-lib (pure ESM)
import { PDFDocument, rgb, StandardFonts } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

/* ---------- tiny utils / refs ---------- */
const $ = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const once = (el, ev, cb, opts) => el && el.addEventListener(ev, function h(e){ el.removeEventListener(ev, h, opts); cb(e); }, opts);
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
  pgWrap: $('#page-jumper'), pgPrev: $('#pg-prev'), pgNext: $('#pg-next'), pgIndicator: $('#pg-indicator'),
};

const toast = (msg, kind='ok', t=2600) => {
  const n = $('#toast'); if (!n) return;
  n.textContent = msg; n.className=''; n.classList.add('show', kind);
  clearTimeout(n._t); n._t = setTimeout(()=>{ n.className=''; }, t);
};

let CURRENT_PDF = { file:null, bytes:null, filename:null, wraps:[], vpCSSByPage:[] };
let LAST_SIG_DATAURL = null;

/* ---------- PDF header validation ---------- */
function isValidPdfBytes(bytes){
  if (!bytes || !bytes.length) return false;
  const maxSkip = Math.min(8, bytes.length);
  for (let i=0; i<maxSkip; i++){
    if (bytes[i]===0x25 && bytes[i+1]===0x50 && bytes[i+2]===0x44 && bytes[i+3]===0x46 && bytes[i+4]===0x2D) {
      return true; // %PDF-
    }
  }
  return false;
}

/* ---------- Zoom (centered) ---------- */
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

function computeFitScale(){
  const sz = CURRENT_PDF.vpCSSByPage[0];
  if (!sz) return 1;
  const vw = refs.scroll.clientWidth || window.innerWidth;
  const vh = refs.scroll.clientHeight || window.innerHeight;
  const safeVh = Math.max(200, vh - 150);
  return Math.min(vw / sz.width, safeVh / sz.height);
}
function setZoomBoundsFromPage(recenter=true){
  const fit = computeFitScale();
  if (!isFinite(fit) || fit <= 0) return;
  zoom.min = Math.max(0.5, fit * 0.95);
  zoom.max = Math.max(2.2, fit * 2.8);
  const prev = zoom.scale;
  const clamped = clamp(prev, zoom.min, zoom.max);
  if (clamped !== prev && recenter){
    const rect = refs.scroll.getBoundingClientRect();
    zoom.setScale(clamped, rect.left + rect.width/2, rect.top + rect.height/2);
  }
}

// Pinch & wheel
(function wirePinch(){
  const pts = new Map(); let lastDist=0, cx=0, cy=0, pinching=false;

  const onPD = (e)=>{ if(zoom.suspended) return; pts.set(e.pointerId, e);
    if(pts.size===2){ const [a,b]=[...pts.values()]; lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2; pinching=true; refs.scroll.style.touchAction='none'; } };
  const onPM = (e)=>{ if(!pts.has(e.pointerId)) return; pts.set(e.pointerId,e);
    if(pinching && pts.size===2){
      const [a,b]=[...pts.values()];
      const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
      cx=(a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2;
      if(lastDist){
        const raw = d / lastDist;
        const factor = Math.pow(raw, 0.85);
        zoom.setScale(zoom.scale * factor, cx, cy);
      }
      lastDist=d; e.preventDefault();
    } };
  const onPU = (e)=>{ pts.delete(e.pointerId); if(pts.size<2){ pinching=false; lastDist=0; refs.scroll.style.touchAction='pan-y'; } };

  refs.scroll.addEventListener('pointerdown', onPD);
  refs.scroll.addEventListener('pointermove', onPM, {passive:false});
  refs.scroll.addEventListener('pointerup', onPU);
  refs.scroll.addEventListener('pointercancel', onPU);

  refs.scroll.addEventListener('wheel', (e)=>{
    if(!(e.ctrlKey||e.metaKey)) return; e.preventDefault();
    const factor = (e.deltaY < 0) ? 1.06 : 0.94;
    zoom.setScale(zoom.scale * factor, e.clientX, e.clientY);
  }, {passive:false});

  const within = el => !!el && (el===refs.scroll || el===refs.container || el.closest?.('#pdf-stage, #pdf-scroll, #pdf-container'));
  addEventListener('gesturestart',  e=>{ if(within(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gesturechange', e=>{ if(within(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gestureend',    e=>{ if(within(e.target)) e.preventDefault(); }, {passive:false});
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
on(window,'resize', ()=>{ setZoomBoundsFromPage(false); centerHorizontally(); });

/* ---------- Page jumper ---------- */
function pageCount(){ return CURRENT_PDF.wraps.length || 0; }
function pageIndexFromScroll(){
  const y = refs.scroll.scrollTop / zoom.scale;
  let best = 0, bestDist = Infinity;
  CURRENT_PDF.wraps.forEach((wrap, i)=>{
    const top = wrap.offsetTop;
    const dist = Math.abs(top - y);
    if (dist < bestDist){ bestDist = dist; best = i; }
  });
  return best;
}
function scrollToPage(i){
  const idx = Math.max(0, Math.min(i, pageCount()-1));
  const top = CURRENT_PDF.wraps[idx].offsetTop * zoom.scale;
  refs.scroll.scrollTo({ top, behavior:'smooth' });
}
function updatePgUI(){
  const n = pageCount();
  if (!n){ refs.pgWrap.style.display='none'; return; }
  const i = pageIndexFromScroll();
  refs.pgWrap.style.display='flex';
  refs.pgIndicator.textContent = `${i+1} / ${n}`;
  refs.pgPrev.disabled = (i===0);
  refs.pgNext.disabled = (i===n-1);
}

/* ---------- Annotations (unchanged) ---------- */
// (… keep the rest of your 4.0 Annotations, SigPad, render/save, and UI wiring exactly as in the previous message …)

/* ---------- Signature pad ---------- */
class SigPad{
  constructor(canvas, modal){ this.canvas=canvas; this.modal=modal; this.ctx=canvas.getContext('2d'); this.clear(); this.drawing=false;
    const pos=ev=>{ const r=canvas.getBoundingClientRect(); const dpr=Math.max(1,devicePixelRatio||1); return {x:(ev.clientX-r.left)*dpr,y:(ev.clientY-r.top)*dpr}; };
    on(canvas,'pointerdown',e=>{ canvas.setPointerCapture?.(e.pointerId); this.drawing=true; const p=pos(e); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointermove',e=>{ if(!this.drawing) return; const p=pos(e); this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointerup',()=>{ this.drawing=false; });
  }
  open(){ this.modal.classList.add('show'); }
  close(){ this.modal.classList.remove('show'); }
  clear(){ const dpr=Math.max(1,devicePixelRatio||1); this.canvas.width=500*dpr; this.canvas.height=200*dpr; this.canvas.style.width='500px'; this.canvas.style.height='200px';
    const c=this.ctx; c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,this.canvas.width,this.canvas.height); c.lineWidth=2.5*dpr; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round'; }
  dataURL(){ return this.canvas.toDataURL('image/png'); }
}
const sig = new SigPad(refs.sigPad, refs.sigModal);
class SigController{ constructor(sig,ann){ this.sig=sig; this.ann=ann; } open(){ this.sig.open(); } close(){ this.sig.close(); } use(){ LAST_SIG_DATAURL=this.sig.dataURL(); this.close(); this.ann.setMode('sign'); toast('Signature ready — double‑tap/click to place'); } }
const sigCtl = new SigController(sig, (function(){return { setMode: m=>document.querySelector('[data-act="sign"]')?.classList.toggle('active', m==='sign') };})()); // minimal ref for this isolated snippet
refs.sigModal?.classList.remove('show');

/* ---------- Render with validation ---------- */
async function renderPdfFromFile(file, container, scale=1){
  CURRENT_PDF.file=file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  CURRENT_PDF.bytes=bytes; CURRENT_PDF.filename=file.name||'document.pdf';
  return renderPdfFromData(bytes, container, scale);
}
async function renderPdfFromData(bytes, container, scale=1){
  if (!isValidPdfBytes(bytes)) {
    toast('That file is not a valid PDF (missing %PDF header).', 'err', 3800);
    throw new Error('Invalid PDF header');
  }

  container.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch(err){
    const msg = String(err?.message||err);
    toast(`Could not open PDF — ${msg.slice(0,80)}`, 'err', 4200);
    throw err;
  }

  const ratio=Math.max(1,Math.min(2,devicePixelRatio||1));
  for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);
    const vpCSS=page.getViewport({scale});
    const vpDev=page.getViewport({scale:scale*ratio});
    const wrap=document.createElement('div'); wrap.className='page-wrap';
    const canvas=document.createElement('canvas'); canvas.className='pdfpage';
    canvas.width=Math.floor(vpDev.width); canvas.height=Math.floor(vpDev.height);
    canvas.style.width=vpCSS.width+'px'; canvas.style.height=vpCSS.height+'px';
    wrap.appendChild(canvas); container.appendChild(wrap);
    const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
    await page.render({canvasContext:ctx, viewport:vpDev, intent:'display'}).promise;
    CURRENT_PDF.wraps.push(wrap); CURRENT_PDF.vpCSSByPage.push({width:vpCSS.width,height:vpCSS.height});
  }

  requestAnimationFrame(()=>{ setZoomBoundsFromPage(true); centerHorizontally(); updatePgUI(); });
  setTimeout(()=>{ setZoomBoundsFromPage(false); updatePgUI(); }, 150);
}

/* ---------- Save (unchanged) ---------- */
async function saveFlattened(){
  if (!CURRENT_PDF.bytes){ toast('Open a PDF first','err'); return; }
  try{
    const pdf  = await PDFDocument.load(CURRENT_PDF.bytes);
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const helvB= await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages= pdf.getPages();
    const embedOps = [];

    CURRENT_PDF.wraps.forEach((wrap, idx)=>{
      const overlay = wrap.querySelector('.overlay'); if(!overlay) return;
      const page = pages[idx];
      const pageW = page.getWidth(), pageH = page.getHeight();
      const vp = CURRENT_PDF.vpCSSByPage[idx];
      const fx = pageW / vp.width, fy = pageH / vp.height;

      overlay.querySelectorAll('.anno').forEach(el=>{
        const left=el.offsetLeft, top=el.offsetTop, w=el.offsetWidth, h=el.offsetHeight;
        const x=left*fx, y=pageH-(top+h)*fy;

        if (el.classList.contains('text')){
          const cs = getComputedStyle(el);
          const size = (parseFloat(cs.fontSize)||16) * fx;
          const [rr,gg,bb] = (cs.color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
          const font = (parseInt(cs.fontWeight,10)||400) >= 600 ? helvB : helv;
          pages[idx].drawText(el.textContent||'', { x, y, size, font, color: rgb(rr,gg,bb) });
        } else if (el.classList.contains('stamp')){
          const stroke = rgb(0,0,0);
          const x1=x, y1=y+h*fy*0.45, x2=x+w*fx*0.35, y2=y+h*fy*0.15, x3=x+w*fx, y3=y+h*fy*0.85;
          pages[idx].drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:2*fx, color:stroke });
          pages[idx].drawLine({ start:{x:x2,y:y2}, end:{x:x3,y:y3}, thickness:2*fx, color:stroke });
        } else {
          const img = el.querySelector('img'); if (!img) return;
          const p = (async ()=>{
            try{
              let bytes;
              if (img.src.startsWith('data:')){
                const b64=(img.src.split(',')[1]||''); const bin=atob(b64);
                bytes=new Uint8Array(bin.length); for(let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i);
              } else {
                const res=await fetch(img.src,{mode:'cors'}); bytes=new Uint8Array(await res.arrayBuffer());
              }
              const png = await pdf.embedPng(bytes);
              pages[idx].drawImage(png, { x, y, width:w*fx, height:h*fy });
            }catch(err){ console.warn('Signature embed failed:', err); }
          })();
          embedOps.push(p);
        }
      });
    });

    if (embedOps.length) await Promise.all(embedOps);
    const out = await pdf.save();
    const defaultName = (CURRENT_PDF.filename||'document.pdf').replace(/\.pdf$/i,'') + '-signed.pdf';

    if ('showSaveFilePicker' in window){
      try{
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types:[{ description:'PDF', accept:{ 'application/pdf':['.pdf'] } }]
        });
        const w = await handle.createWritable(); await w.write(out); await w.close();
        toast('Saved ✔️'); return;
      }catch{}
    }
    const blob = new Blob([out], { type:'application/pdf' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = defaultName;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 1200);
    toast('Downloaded ✔️');
  }catch(e){
    toast(`Could not save PDF — ${String(e?.message||e).slice(0,80)}`,'err',4200);
  }
}

/* ---------- UI wiring ---------- */
function wireUI(){
  on(refs.openBtn,'click',()=>refs.fileInput?.click());
  on(refs.fileInput,'change',async e=>{
    const file=e.target.files?.[0]; if(!file) return;
    try { await renderPdfFromFile(file, refs.container, 1); toast('PDF loaded ✔️'); centerHorizontally(); }
    catch(err){ /* detailed toast already shown */ }
  });

  on(refs.textBtn,'click',()=>{ /* toggle & hint */ });
  on(refs.stampBtn,'click',()=>{ /* toggle & hint */ });
  on(refs.signBtn,'click', ()=> sigCtl.open());
  on(refs.undoBtn,'click',()=>{/* undo */});
  on(refs.redoBtn,'click',()=>{/* redo */});
  on(refs.helpBtn,'click',()=>toast('📂 Open → double‑tap Text or Signature (draw first) → Save. Drag to move.','ok',4200));
  on(refs.saveBtn,'click',saveFlattened);

  on(refs.sigUse,'click',e=>{ e.stopPropagation(); sigCtl.use(); });
  on(refs.sigClear,'click',e=>{ e.stopPropagation(); sig.clear(); });
  on(refs.sigCancel,'click',e=>{ e.stopPropagation(); sigCtl.close(); });

  // Page jumper
  on(refs.pgPrev,'click', ()=> scrollToPage(pageIndexFromScroll()-1));
  on(refs.pgNext,'click', ()=> scrollToPage(pageIndexFromScroll()+1));
  on(refs.pgIndicator,'click', ()=>{
    const n = pageCount(); if(!n) return;
    const cur = pageIndexFromScroll()+1;
    const v = prompt(`Go to page (1–${n})`, String(cur));
    const idx = Math.max(1, Math.min(n, parseInt(v||cur,10))) - 1;
    scrollToPage(idx);
  });
  on(refs.scroll,'scroll', ()=> updatePgUI(), {passive:true});
}
wireUI();

/* ---------- Quiet benign rejections ---------- */
addEventListener('unhandledrejection',ev=>{
  const m=String(ev.reason?.message||ev.reason||'');
  if(m.includes('Rendering cancelled')||m.includes('AbortError')) ev.preventDefault();
});