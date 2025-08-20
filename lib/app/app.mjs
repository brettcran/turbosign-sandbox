// TurboSign v4.1 — ESM + IconPark (via Iconify)
// ----------------------------------------------

// PDF.js (ESM)
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.mjs';

// Iconify web component (ESM) — renders IconPark icons used in index.html
import 'https://cdn.jsdelivr.net/npm/iconify-icon@3.0.0/dist/iconify-icon.min.js';

// pdf-lib (ESM) lazy loader for Save
async function loadPdfLib() {
  const mod = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
  return { PDFDocument: mod.PDFDocument, rgb: mod.rgb, StandardFonts: mod.StandardFonts };
}

/* ---------- Refs & State ---------- */
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

let pdfDoc = null;
let originalBytes = null;
let filename = null;
let activeTool = null;
let signatureDataURL = null;

/* ---------- UI: toast ---------- */
function toast(msg, kind='ok', t=2400){
  if (!refs.toast) return;
  refs.toast.textContent = msg;
  refs.toast.className = '';
  refs.toast.classList.add('show', kind);
  clearTimeout(refs.toast._t);
  refs.toast._t = setTimeout(()=>{ refs.toast.className=''; }, t);
}

/* ---------- Render PDF ---------- */
async function renderPdfFromData(bytes) {
  refs.container.innerHTML='';
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

  for (let i=1;i<=pdfDoc.numPages;i++){
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale:1 }); // 1:1

    const wrap = document.createElement('div');
    wrap.className='page-wrap'; wrap.dataset.page = String(i-1);
    wrap.style.position='relative';

    const canvas = document.createElement('canvas');
    canvas.className='pdfpage';
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    canvas.style.width = vp.width+'px'; canvas.style.height = vp.height+'px';
    wrap.appendChild(canvas);

    const overlay = document.createElement('div');
    overlay.className='overlay'; overlay.dataset.pageIndex = String(i-1);
    wrap.appendChild(overlay);

    refs.container.appendChild(wrap);

    const ctx = canvas.getContext('2d', { alpha:false });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
  }
  armOverlays();
  toast('PDF loaded ✔️');
}

/* ---------- Helpers ---------- */
const clamp = (v, lo, hi)=>Math.max(lo, Math.min(hi, v));
function localXY(overlay, clientX, clientY){
  const r = overlay.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}
function makeDraggable(el){
  let dragging=false, offX=0, offY=0;
  el.addEventListener('pointerdown', e=>{
    if (e.target.classList.contains('handle')) return;
    dragging=true; el.setPointerCapture?.(e.pointerId);
    offX = e.offsetX; offY = e.offsetY;
  });
  el.addEventListener('pointermove', e=>{
    if (!dragging) return;
    const p = el.parentElement; if (!p) return;
    const pr = p.getBoundingClientRect();
    let nx = e.clientX - pr.left - offX;
    let ny = e.clientY - pr.top  - offY;
    nx = clamp(nx, 0, Math.max(0, p.clientWidth - el.offsetWidth));
    ny = clamp(ny, 0, Math.max(0, p.clientHeight - el.offsetHeight));
    el.style.left = nx+'px'; el.style.top = ny+'px';
  });
  el.addEventListener('pointerup', e=>{ dragging=false; el.releasePointerCapture?.(e.pointerId); });
}
function makeResizable(el){
  const h = document.createElement('div'); h.className='handle br'; el.appendChild(h);
  let resizing=false, sx=0, sy=0, sw=0, sh=0;
  h.addEventListener('pointerdown', e=>{
    e.stopPropagation(); resizing=true; h.setPointerCapture?.(e.pointerId);
    sx=e.clientX; sy=e.clientY; sw=el.offsetWidth; sh=el.offsetHeight;
  });
  h.addEventListener('pointermove', e=>{
    if (!resizing) return;
    el.style.width  = Math.max(24, sw + (e.clientX - sx))+'px';
    el.style.height = Math.max(24, sh + (e.clientY - sy))+'px';
  });
  h.addEventListener('pointerup', e=>{ resizing=false; h.releasePointerCapture?.(e.pointerId); });
}

/* ---------- Annotations ---------- */
function addText(overlay, x, y){
  const el=document.createElement('div'); el.className='anno text';
  el.contentEditable='true'; el.style.left=x+'px'; el.style.top=y+'px';
  overlay.appendChild(el); makeDraggable(el); el.focus();
}
function addStamp(overlay, x, y){
  const el=document.createElement('div'); el.className='anno stamp';
  el.style.left=x+'px'; el.style.top=y+'px';
  el.innerHTML=`<svg viewBox="0 0 24 24" width="22" height="22"
    style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round">
    <polyline points="20 6 9 17 4 12"/></svg>`;
  overlay.appendChild(el); makeDraggable(el);
}
function addImageLike(overlay, x, y, dataURL, kind/* sign|image */){
  const el=document.createElement('div'); el.className=`anno ${kind}`;
  el.style.left=x+'px'; el.style.top=y+'px'; el.style.width='160px'; el.style.height='auto';
  const img=new Image(); img.src=dataURL; img.style.display='block'; img.draggable=false;
  el.appendChild(img); overlay.appendChild(el);
  makeDraggable(el); makeResizable(el);
}

/* ---------- Overlays: double‑tap/dblclick ---------- */
function armOverlays(){
  refs.container.querySelectorAll('.overlay').forEach(ov=>{
    ov.replaceWith(ov.cloneNode(true));
  });
  refs.container.querySelectorAll('.overlay').forEach(ov=>{
    ov.addEventListener('dblclick', e=>{
      const {x,y}=localXY(ov, e.clientX, e.clientY);
      if (activeTool==='text') addText(ov,x,y);
      else if (activeTool==='stamp') addStamp(ov,x,y);
      else if (activeTool==='sign' && signatureDataURL) addImageLike(ov,x,y,signatureDataURL,'sign');
    });
    // touch double‑tap
    let lastT=0,lx=0,ly=0;
    ov.addEventListener('pointerdown', e=>{
      if (e.pointerType!=='touch') return;
      const now=performance.now(); const {x,y}=localXY(ov, e.clientX, e.clientY);
      const dbl = (now-lastT<300 && Math.abs(x-lx)<24 && Math.abs(y-ly)<24);
      lastT=now; lx=x; ly=y; if(!dbl) return;
      if (activeTool==='text') addText(ov,x,y);
      else if (activeTool==='stamp') addStamp(ov,x,y);
      else if (activeTool==='sign' && signatureDataURL) addImageLike(ov,x,y,signatureDataURL,'sign');
    });
  });
}

/* ---------- Signature Modal ---------- */
const sig = {
  open(){ refs.sigModal.classList.add('show'); },
  close(){ refs.sigModal.classList.remove('show'); },
  clear(){
    const c=refs.sigPad.getContext('2d');
    c.fillStyle='#fff'; c.fillRect(0,0,refs.sigPad.width,refs.sigPad.height);
    c.lineWidth=2.5; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round';
  },
  init(){
    const c=refs.sigPad.getContext('2d'); this.clear();
    let drawing=false;
    refs.sigPad.addEventListener('pointerdown', e=>{
      drawing=true; refs.sigPad.setPointerCapture?.(e.pointerId);
      c.beginPath(); c.moveTo(e.offsetX,e.offsetY);
    });
    refs.sigPad.addEventListener('pointermove', e=>{
      if(!drawing) return; c.lineTo(e.offsetX,e.offsetY); c.stroke();
      c.beginPath(); c.moveTo(e.offsetX,e.offsetY);
    });
    refs.sigPad.addEventListener('pointerup', e=>{
      drawing=false; refs.sigPad.releasePointerCapture?.(e.pointerId);
    });
    refs.sigUse.addEventListener('click', ()=>{
      signatureDataURL = refs.sigPad.toDataURL('image/png');
      this.close(); activeTool='sign';
      toast('Signature ready — double‑tap a page to place');
    });
    refs.sigClear.addEventListener('click', ()=> this.clear());
    refs.sigCancel.addEventListener('click', ()=> this.close());
  }
};
sig.init();

/* ---------- Toolbar ---------- */
refs.toolbar.addEventListener('click', e=>{
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;

  if (act==='open'){ refs.fileInput.click(); return; }
  if (act==='save'){ saveFlattened(); return; }
  if (act==='help'){ toast('Open a PDF → double‑tap to add Text/Stamp/Signature → Save to flatten.'); return; }
  if (act==='sign'){ sig.open(); return; }

  if (['text','stamp'].includes(act)){
    activeTool = act;
    toast(act==='text' ? 'Text: double‑tap to place' : 'Stamp: double‑tap to place');
  }
});

/* ---------- File open ---------- */
refs.fileInput.addEventListener('change', async e=>{
  const file=e.target.files?.[0]; if(!file) return;
  originalBytes = new Uint8Array(await file.arrayBuffer());
  filename = file.name || 'document.pdf';
  try { await renderPdfFromData(originalBytes); } catch(err){ console.error(err); toast('Could not open PDF','err'); }
});

/* ---------- Save (flatten) ---------- */
async function saveFlattened(){
  if (!originalBytes){ toast('Open a PDF first','err'); return; }
  try{
    const { PDFDocument, rgb } = await loadPdfLib();
    const pdf = await PDFDocument.load(originalBytes);
    const pages = pdf.getPages();

    document.querySelectorAll('.page-wrap').forEach((wrap, idx)=>{
      const page = pages[idx];
      const canvas = wrap.querySelector('canvas');
      const rectC = canvas.getBoundingClientRect();

      wrap.querySelectorAll('.anno').forEach(el=>{
        const r = el.getBoundingClientRect();
        const x = r.left - rectC.left;
        const y = rectC.height - (r.top - rectC.top) - r.height;

        if (el.classList.contains('text')){
          page.drawText(el.textContent||'', { x, y, size:16, color: rgb(0,0,0) });
        } else if (el.classList.contains('stamp')){
          page.drawText('✓', { x, y, size:22, color: rgb(0,0,0) });
        } else if (el.classList.contains('sign') || el.classList.contains('image')){
          const img = el.querySelector('img'); if (!img) return;
          const b64=(img.src.split(',')[1]||''); const bin=atob(b64);
          const bytes=new Uint8Array(bin.length); for(let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i);
          (async ()=>{
            const png = await pdf.embedPng(bytes);
            page.drawImage(png, { x, y, width:r.width, height:r.height });
          })();
        }
      });
    });

    const out = await pdf.save();
    const name = (filename||'document.pdf').replace(/\.pdf$/i,'') + '-annotated.pdf';
    const blob = new Blob([out], { type:'application/pdf' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1200);
    toast('Saved ✔️');
  }catch(e){
    console.error(e); toast('Could not save PDF','err');
  }
}