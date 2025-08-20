// TurboSign v4.1 — Fully ESM, fixed icons/buttons/PDF open
// --------------------------------------------------------

// PDF.js (ESM)
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
// IMPORTANT: v5 provides a module worker at pdf.worker.mjs (no ".min" file)
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.mjs';

// Feather icons (ESM, versioned)
import feather from 'https://cdn.jsdelivr.net/npm/feather-icons@4.29.0/dist/feather.esm.js';
document.addEventListener('DOMContentLoaded', () => { try { feather.replace(); } catch {} });

// pdf-lib (ESM) loader — loads only when saving
async function loadPdfLib() {
  const mod = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
  return { PDFDocument: mod.PDFDocument, rgb: mod.rgb, StandardFonts: mod.StandardFonts };
}

/* ------------ DOM refs ------------ */
const refs = {
  toolbar: document.getElementById('toolbar'),
  fileInput: document.getElementById('file-input'),
  container: document.getElementById('pdf-container'),
  toast: document.getElementById('toast'),
  sigModal: document.getElementById('sign-modal'),
  sigPad: document.getElementById('sig-pad'),
  sigUse: document.getElementById('sig-use'),
  sigClear: document.getElementById('sig-clear'),
  sigCancel: document.getElementById('sig-cancel')
};

/* ------------ state ------------ */
let pdfDoc = null;
let originalBytes = null;
let filename = null;
let activeTool = null;
let signatureDataURL = null;

const annotations = new Map(); // pageIndex -> Set<HTMLElement>

/* ------------ helpers ------------ */
function toast(msg, kind='ok', t=2200){
  if (!refs.toast) return;
  refs.toast.textContent = msg;
  refs.toast.className = '';
  refs.toast.classList.add('show', kind);
  clearTimeout(refs.toast._t);
  refs.toast._t = setTimeout(()=>{ refs.toast.className=''; }, t);
}
const clamp = (v, lo, hi)=>Math.max(lo, Math.min(hi, v));

/* ------------ rendering ------------ */
async function renderPdfFromData(bytes) {
  refs.container.innerHTML = '';
  annotations.clear();
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 1 }); // 1:1 CSS pixels

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.position = 'relative';

    const canvas = document.createElement('canvas');
    canvas.className = 'pdfpage';
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';

    wrap.appendChild(canvas);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.dataset.pageIndex = String(i - 1);
    wrap.appendChild(overlay);

    refs.container.appendChild(wrap);

    const ctx = canvas.getContext('2d', { alpha:false });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    annotations.set(i - 1, new Set());
  }
}

/* ------------ annotation creation ------------ */
function overlayFromEventTarget(target){
  return target.closest?.('.overlay');
}
function pageIndexFromOverlay(overlay){
  return parseInt(overlay?.dataset.pageIndex || '0', 10);
}
function localXY(overlay, clientX, clientY){
  const r = overlay.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}
function makeDraggable(el){
  let dragging=false, offX=0, offY=0, overlay=null;
  el.addEventListener('pointerdown', e=>{
    overlay = el.parentElement;
    dragging = true;
    el.setPointerCapture?.(e.pointerId);
    const pos = localXY(overlay, e.clientX, e.clientY);
    offX = pos.x - el.offsetLeft;
    offY = pos.y - el.offsetTop;
  });
  el.addEventListener('pointermove', e=>{
    if(!dragging) return;
    const pos = localXY(el.parentElement, e.clientX, e.clientY);
    let nx = pos.x - offX, ny = pos.y - offY;
    const maxX = el.parentElement.clientWidth - el.offsetWidth;
    const maxY = el.parentElement.clientHeight - el.offsetHeight;
    el.style.left = clamp(nx, 0, Math.max(0, maxX)) + 'px';
    el.style.top  = clamp(ny, 0, Math.max(0, maxY)) + 'px';
  });
  el.addEventListener('pointerup', e=>{
    dragging=false;
    el.releasePointerCapture?.(e.pointerId);
  });
}
function makeResizable(el){
  const h = document.createElement('div');
  h.className = 'handle br';
  el.appendChild(h);

  let resizing=false, startX=0, startY=0, startW=0, startH=0;
  h.addEventListener('pointerdown', e=>{
    e.stopPropagation();
    resizing = true;
    h.setPointerCapture?.(e.pointerId);
    startX = e.clientX; startY = e.clientY;
    startW = el.offsetWidth; startH = el.offsetHeight;
  });
  h.addEventListener('pointermove', e=>{
    if(!resizing) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    el.style.width  = Math.max(24, startW + dx) + 'px';
    el.style.height = Math.max(24, startH + dy) + 'px';
  });
  h.addEventListener('pointerup', e=>{
    resizing=false;
    h.releasePointerCapture?.(e.pointerId);
  });
}

function addText(overlay, x, y){
  const el = document.createElement('div');
  el.className = 'anno text';
  Object.assign(el.style, { left:x+'px', top:y+'px' });
  el.contentEditable = 'true';
  overlay.appendChild(el);
  makeDraggable(el);
  el.focus();
  annotations.get(pageIndexFromOverlay(overlay)).add(el);
}

function addStamp(overlay, x, y){
  const el = document.createElement('div');
  el.className = 'anno stamp';
  Object.assign(el.style, { left:x+'px', top:y+'px' });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round"><polyline points="20 6 9 17 4 12"/></svg>`;
  overlay.appendChild(el);
  makeDraggable(el);
  annotations.get(pageIndexFromOverlay(overlay)).add(el);
}

function addImageLike(overlay, x, y, dataURL, kind /* 'sign' | 'image' */){
  const el = document.createElement('div');
  el.className = `anno ${kind}`;
  Object.assign(el.style, { left:x+'px', top:y+'px', width:'160px', height:'auto' });
  const img = new Image();
  img.src = dataURL;
  img.style.display='block';
  img.style.userSelect='none';
  img.draggable = false;
  el.appendChild(img);
  overlay.appendChild(el);
  makeDraggable(el);
  makeResizable(el);
  annotations.get(pageIndexFromOverlay(overlay)).add(el);
}

/* ------------ signature modal ------------ */
const sig = {
  open(){ refs.sigModal.classList.add('show'); },
  close(){ refs.sigModal.classList.remove('show'); },
  clear(){
    const c = refs.sigPad.getContext('2d');
    c.fillStyle = '#fff'; // white pad background
    c.fillRect(0,0,refs.sigPad.width, refs.sigPad.height);
    c.lineWidth = 2.5; c.lineCap='round'; c.lineJoin='round'; c.strokeStyle='#000';
  },
  init(){
    const c = refs.sigPad.getContext('2d');
    this.clear();
    let drawing=false;
    refs.sigPad.addEventListener('pointerdown', e=>{
      drawing=true;
      c.beginPath();
      c.moveTo(e.offsetX, e.offsetY);
      refs.sigPad.setPointerCapture?.(e.pointerId);
    });
    refs.sigPad.addEventListener('pointermove', e=>{
      if(!drawing) return;
      c.lineTo(e.offsetX, e.offsetY);
      c.stroke();
      c.beginPath(); c.moveTo(e.offsetX, e.offsetY);
    });
    refs.sigPad.addEventListener('pointerup', e=>{
      drawing=false; refs.sigPad.releasePointerCapture?.(e.pointerId);
    });
    refs.sigUse.addEventListener('click', ()=>{
      signatureDataURL = refs.sigPad.toDataURL('image/png'); // transparent outside ink
      this.close();
      activeTool = 'sign'; // arm placement
      toast('Double‑tap a page to place your signature');
    });
    refs.sigClear.addEventListener('click', ()=> this.clear());
    refs.sigCancel.addEventListener('click', ()=> this.close());
  }
};
sig.init();

/* ------------ photo input (hidden) ------------ */
const photoInput = document.createElement('input');
photoInput.type = 'file';
photoInput.accept = 'image/*';
photoInput.capture = 'environment'; // mobile camera hint
photoInput.style.display = 'none';
document.body.appendChild(photoInput);

/* ------------ save (flatten) ------------ */
async function saveFlattened(){
  if (!originalBytes) { toast('Open a PDF first','err'); return; }
  try{
    const { PDFDocument, rgb } = await loadPdfLib();
    const pdf = await PDFDocument.load(originalBytes);
    const pages = pdf.getPages();

    // walk pages & annos
    document.querySelectorAll('.page-wrap').forEach((wrap, idx)=>{
      const page = pages[idx];
      const canvas = wrap.querySelector('canvas');
      const canvasRect = canvas.getBoundingClientRect();

      wrap.querySelectorAll('.anno').forEach(el=>{
        const r = el.getBoundingClientRect();
        const x = r.left - canvasRect.left;
        const y = canvasRect.height - (r.top - canvasRect.top) - r.height;

        if (el.classList.contains('text')){
          const txt = el.textContent || '';
          page.drawText(txt, { x, y, size:16, color: rgb(0,0,0) });
        } else if (el.classList.contains('stamp')){
          page.drawText('✓', { x, y, size:22, color: rgb(0,0,0) });
        } else if (el.classList.contains('sign') || el.classList.contains('image')){
          const img = el.querySelector('img'); if (!img) return;
          // dataURL -> bytes
          const b64 = (img.src.split(',')[1]||''); const bin = atob(b64);
          const bytes = new Uint8Array(bin.length); for (let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i);
          // assume PNG (signature/photo dataURL will be png from canvas or file)
          // If you want jpg support, detect MIME and use embedJpg
          // page coords: use DOM rect size
          (async ()=>{
            const png = await pdf.embedPng(bytes);
            page.drawImage(png, { x, y, width:r.width, height:r.height });
          })();
        }
      });
    });

    const out = await pdf.save();
    const dlName = (filename||'document.pdf').replace(/\.pdf$/i,'') + '-annotated.pdf';
    const blob = new Blob([out], { type:'application/pdf' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = dlName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1200);
    toast('Saved ✔️');
  }catch(e){
    console.error(e);
    toast('Could not save PDF','err');
  }
}

/* ------------ toolbar wiring (delegation) ------------ */
refs.toolbar.addEventListener('click', e=>{
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;

  if (act === 'open') { refs.fileInput.click(); return; }
  if (act === 'save') { saveFlattened(); return; }
  if (act === 'help') { toast('Open a PDF → double‑tap to add Text/Stamp/Signature; Save to flatten.'); return; }
  if (act === 'sign') { sig.open(); return; }
  if (act === 'photo') { photoInput.value = ''; photoInput.click(); return; }

  // tools: text / stamp
  if (act === 'text' || act === 'stamp'){
    activeTool = act;
    toast(act==='text' ? 'Text: double‑tap to place' : 'Stamp: double‑tap to place');
  }
});

/* ------------ file handlers ------------ */
refs.fileInput.addEventListener('change', async e=>{
  const file = e.target.files?.[0]; if (!file) return;
  originalBytes = new Uint8Array(await file.arrayBuffer());
  filename = file.name || 'document.pdf';
  try {
    await renderPdfFromData(originalBytes);
    toast('PDF loaded ✔️');
  } catch (err){
    console.error(err);
    toast('Could not open PDF','err');
  }
});

/* ------------ overlay interactions (double‑tap) ------------ */
function armOverlays(){
  refs.container.querySelectorAll('.overlay').forEach(ov=>{
    // desktop dblclick
    ov.addEventListener('dblclick', e=>{
      if (!pdfDoc) return;
      const { x, y } = localXY(ov, e.clientX, e.clientY);
      if (activeTool === 'text') addText(ov, x, y);
      else if (activeTool === 'stamp') addStamp(ov, x, y);
      else if (activeTool === 'sign' && signatureDataURL) addImageLike(ov, x, y, signatureDataURL, 'sign');
    });

    // touch double‑tap
    let lastT=0, lastX=0, lastY=0;
    ov.addEventListener('pointerdown', e=>{
      if (e.pointerType!=='touch') return;
      const now=performance.now();
      const { x, y } = localXY(ov, e.clientX, e.clientY);
      const isDouble = (now-lastT<300 && Math.abs(x-lastX)<24 && Math.abs(y-lastY)<24);
      lastT=now; lastX=x; lastY=y;
      if (!isDouble) return;
      if (activeTool === 'text') addText(ov, x, y);
      else if (activeTool === 'stamp') addStamp(ov, x, y);
      else if (activeTool === 'sign' && signatureDataURL) addImageLike(ov, x, y, signatureDataURL, 'sign');
    });
  });
}

// re-arm overlays after each render
const mo = new MutationObserver(()=>armOverlays());
mo.observe(refs.container, { childList:true, subtree:true });

/* ------------ photo placing ------------ */
photoInput.addEventListener('change', async e=>{
  const f = e.target.files?.[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    const dataURL = String(reader.result||'');
    // place on first visible page center
    const firstOverlay = refs.container.querySelector('.overlay');
    if (!firstOverlay) { toast('Open a PDF first','err'); return; }
    const r = firstOverlay.getBoundingClientRect();
    const x = r.width/2 - 100, y = r.height/2 - 60;
    addImageLike(firstOverlay, x, y, dataURL, 'image');
    toast('Photo inserted ✔️');
  };
  reader.readAsDataURL(f);
});

// init pad background once for a clean white canvas
(()=>{ try { const c = refs.sigPad.getContext('2d'); c.fillStyle='#fff'; c.fillRect(0,0,refs.sigPad.width, refs.sigPad.height); } catch {} })();
