// ============================
// TurboSign App.mjs (v4.1 ESM)
// - PDFs open & render (pdf.js v5 ESM)
// - Icons load (feather ESM + fallback)
// - Tools: text (double-tap), stamp (✓), signature (modal; draggable+resizable), photo (inserter)
// - Save: flatten text/stamp/sign/photo onto pages (pdf-lib ESM)
// ============================

// --- Imports ---
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.mjs';

// Feather icons (ESM with fallback)
import feather from 'https://cdn.jsdelivr.net/npm/feather-icons@4.29.0/dist/feather.min.js?module';
document.addEventListener('DOMContentLoaded', () => { try { feather.replace(); } catch {} });
if (!feather || typeof feather.replace !== 'function') {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/feather-icons@4.29.0/dist/feather.min.js';
  s.onload = () => window.feather?.replace?.();
  document.head.appendChild(s);
}

// pdf-lib ESM (load on demand)
async function loadPdfLib() {
  const mod = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
  return {
    PDFDocument:   mod.PDFDocument,
    rgb:           mod.rgb,
    StandardFonts: mod.StandardFonts
  };
}

// --- State/Refs ---
let pdfDoc = null;
let currentFileName = null;
let currentScale = 1;                // canvas and CSS are 1:1 here
let activeTool = null;
let currentSigDataUrl = null;

const $ = s => document.querySelector(s);
const refs = {
  toolbar: $('#toolbar'),
  fileInput: $('#file-input'),
  container: $('#pdf-container'),
  toast: $('#toast'),
  sigModal: $('#sign-modal'),
  sigPad: $('#sig-pad'),
  sigUse: $('#sig-use'),
  sigClear: $('#sig-clear'),
  sigCancel: $('#sig-cancel')
};

// --- Toast ---
function showToast(msg, kind = '') {
  const el = refs.toast;
  el.textContent = msg;
  el.className = kind ? `show ${kind}` : 'show';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, 2400);
}

// --- Open PDF ---
refs.toolbar.addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === 'open') { refs.fileInput.click(); return; }
  if (act === 'save') { saveFlattened(); return; }
  if (act === 'sign') { refs.sigModal.classList.add('show'); return; }
  if (act === 'photo') { openPhotoPicker(); return; }

  // modes: text / stamp
  activeTool = act;
  if (act === 'text') showToast('Text: double‑tap to place');
  if (act === 'stamp') showToast('Stamp: double‑tap to place');
});

refs.fileInput.addEventListener('change', async e => {
  const f = e.target.files?.[0];
  if (!f) return;
  currentFileName = f.name || 'document.pdf';
  const bytes = new Uint8Array(await f.arrayBuffer());
  await renderPdfFromData(bytes);
  showToast('PDF loaded ✔️', 'ok');
});

// --- Render PDF ---
async function renderPdfFromData(bytes) {
  refs.container.innerHTML = '';
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: currentScale });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = String(i - 1);
    wrap.style.position = 'relative';

    const canvas = document.createElement('canvas');
    canvas.className = 'pdfpage';
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    wrap.appendChild(canvas);

    const ctx = canvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    wrap.appendChild(overlay);

    refs.container.appendChild(wrap);
  }
}

// --- Double‑tap to place text/stamp/sign ---
refs.container.addEventListener('dblclick', e => {
  const wrap = e.target.closest('.page-wrap');
  if (!wrap) return;
  const overlay = wrap.querySelector('.overlay');
  const rect = overlay.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (activeTool === 'text') { addText(overlay, x, y); }
  else if (activeTool === 'stamp') { addStamp(overlay, x, y); }
  else if (activeTool === 'sign' && currentSigDataUrl) { addImageLike(overlay, x, y, currentSigDataUrl, 'sign'); }
});

// --- Annotation creators ---
function makeDraggable(el) {
  let dx=0, dy=0, dragging=false;
  el.addEventListener('pointerdown', ev => {
    if (ev.target.classList.contains('handle')) return; // resizing
    dragging = true;
    el.setPointerCapture?.(ev.pointerId);
    dx = ev.clientX - el.offsetLeft;
    dy = ev.clientY - el.offsetTop;
  });
  el.addEventListener('pointermove', ev => {
    if (!dragging) return;
    el.style.left = (ev.clientX - dx) + 'px';
    el.style.top  = (ev.clientY - dy) + 'px';
  });
  el.addEventListener('pointerup', ev => {
    dragging = false;
    el.releasePointerCapture?.(ev.pointerId);
  });
}
function makeResizable(el) {
  const h = document.createElement('div');
  h.className = 'handle br';
  el.appendChild(h);
  let startX=0, startY=0, startW=0, startH=0, resizing=false;
  h.addEventListener('pointerdown', e => {
    e.stopPropagation();
    resizing = true;
    startX = e.clientX; startY = e.clientY;
    startW = el.offsetWidth; startH = el.offsetHeight;
    h.setPointerCapture?.(e.pointerId);
  });
  h.addEventListener('pointermove', e => {
    if (!resizing) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    el.style.width  = Math.max(24, startW + dx) + 'px';
    el.style.height = Math.max(24, startH + dy) + 'px';
  });
  h.addEventListener('pointerup', e => {
    resizing = false;
    h.releasePointerCapture?.(e.pointerId);
  });
}

function addText(overlay, x, y) {
  const el = document.createElement('div');
  el.className = 'anno text';
  el.contentEditable = 'true';
  Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
  overlay.appendChild(el);
  makeDraggable(el);
  el.focus();
}
function addStamp(overlay, x, y) {
  const el = document.createElement('div');
  el.className = 'anno stamp';
  Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round"><polyline points="20 6 9 17 4 12"/></svg>`;
  overlay.appendChild(el);
  makeDraggable(el);
}
function addImageLike(overlay, x, y, dataURL, kind /* 'sign' | 'image' */) {
  const el = document.createElement('div');
  el.className = `anno ${kind}`;
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: '160px', height: 'auto' });
  const img = new Image();
  img.src = dataURL;
  img.style.display = 'block';
  img.style.userSelect = 'none';
  img.draggable = false;
  el.appendChild(img);
  overlay.appendChild(el);
  makeDraggable(el);
  makeResizable(el);
}

// --- Photo insert flow ---
const photoInput = document.createElement('input');
photoInput.type = 'file';
photoInput.accept = 'image/*';
photoInput.capture = 'environment';
photoInput.style.display = 'none';
document.body.appendChild(photoInput);

function openPhotoPicker(){ photoInput.value=''; photoInput.click(); }
photoInput.addEventListener('change', () => {
  const f = photoInput.files?.[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataURL = String(reader.result||'');
    const firstOverlay = refs.container.querySelector('.overlay');
    if (!firstOverlay) { showToast('Open a PDF first','err'); return; }
    // center of first page
    const r = firstOverlay.getBoundingClientRect();
    addImageLike(firstOverlay, r.width/2 - 80, r.height/2 - 50, dataURL, 'image');
    showToast('Photo inserted ✔️', 'ok');
  };
  reader.readAsDataURL(f);
});

// --- Signature modal ---
const sigCtx = refs.sigPad.getContext('2d');
function resetPad() {
  sigCtx.fillStyle = '#fff';  // white pad background (signature ink transparent when placed)
  sigCtx.fillRect(0, 0, refs.sigPad.width, refs.sigPad.height);
  sigCtx.lineWidth = 2.5; sigCtx.lineCap = 'round'; sigCtx.lineJoin = 'round'; sigCtx.strokeStyle = '#000';
}
resetPad();

let drawing = false;
refs.sigPad.addEventListener('pointerdown', e => {
  drawing = true;
  sigCtx.beginPath();
  sigCtx.moveTo(e.offsetX, e.offsetY);
  refs.sigPad.setPointerCapture?.(e.pointerId);
});
refs.sigPad.addEventListener('pointermove', e => {
  if (!drawing) return;
  sigCtx.lineTo(e.offsetX, e.offsetY);
  sigCtx.stroke();
  sigCtx.beginPath(); sigCtx.moveTo(e.offsetX, e.offsetY);
});
refs.sigPad.addEventListener('pointerup', e => {
  drawing = false;
  refs.sigPad.releasePointerCapture?.(e.pointerId);
});
refs.sigUse.addEventListener('click', () => {
  currentSigDataUrl = refs.sigPad.toDataURL('image/png'); // transparent ink
  refs.sigModal.classList.remove('show');
  activeTool = 'sign';
  showToast('Double‑tap to place signature', 'ok');
});
refs.sigClear.addEventListener('click', resetPad);
refs.sigCancel.addEventListener('click', () => refs.sigModal.classList.remove('show'));

// --- Save (flatten all annos) ---
async function saveFlattened() {
  if (!pdfDoc) { showToast('Open a PDF first', 'err'); return; }

  try {
    const { PDFDocument, rgb, StandardFonts } = await loadPdfLib();
    const bytes = await pdfDoc.getData();          // original bytes from pdf.js
    const outDoc = await PDFDocument.load(bytes);
    const helv = await outDoc.embedFont(StandardFonts.Helvetica);
    const helvB = await outDoc.embedFont(StandardFonts.HelveticaBold);

    const pages = outDoc.getPages();

    // For each page-wrap, read DOM annotations and draw into PDF coordinates
    const wraps = refs.container.querySelectorAll('.page-wrap');
    const imageTasks = []; // collect async embed tasks

    wraps.forEach((wrap, idx) => {
      const page = pages[idx];
      if (!page) return;

      const canvas = wrap.querySelector('canvas');
      const overlay = wrap.querySelector('.overlay');
      const cRect = canvas.getBoundingClientRect();

      overlay.querySelectorAll('.anno').forEach(el => {
        const r = el.getBoundingClientRect();
        // DOM -> page coords (canvas is 1:1 with CSS px)
        const x = r.left - cRect.left;
        const y = cRect.height - (r.top - cRect.top) - r.height;
        const w = r.width;
        const h = r.height;

        if (el.classList.contains('text')) {
          const text = el.textContent || '';
          const cs = getComputedStyle(el);
          const size = parseFloat(cs.fontSize) || 16;
          const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
          const color = cs.color.match(/\d+/g)?.map(n => parseInt(n,10)/255) || [0,0,0];
          page.drawText(text, { x, y, size, font: bold ? helvB : helv, color: rgb(color[0], color[1], color[2]) });
        } else if (el.classList.contains('stamp')) {
          // Simple ✓ glyph; if you want the exact path, replace with vector draw
          page.drawText('✓', { x, y, size: Math.max(18, h), font: helvB, color: rgb(0,0,0) });
        } else if (el.classList.contains('sign') || el.classList.contains('image')) {
          const img = el.querySelector('img'); if (!img) return;
          // Convert dataURL to bytes
          const task = (async () => {
            let mime = 'image/png';
            if (img.src.startsWith('data:')) {
              const m = img.src.match(/^data:([^;]+);/);
              if (m) mime = m[1];
              const b64 = (img.src.split(',')[1] || '');
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i=0;i<bytes.length;i++) bytes[i] = bin.charCodeAt(i);
              const embedded = mime.includes('jpeg') || mime.includes('jpg')
                ? await outDoc.embedJpg(bytes)
                : await outDoc.embedPng(bytes);
              page.drawImage(embedded, { x, y, width: w, height: h });
            } else {
              // Remote URL (rare here). Fetch as bytes.
              const res = await fetch(img.src);
              const buf = new Uint8Array(await res.arrayBuffer());
              const embedded = img.src.endsWith('.jpg') || img.src.endsWith('.jpeg')
                ? await outDoc.embedJpg(buf)
                : await outDoc.embedPng(buf);
              page.drawImage(embedded, { x, y, width: w, height: h });
            }
          })();
          imageTasks.push(task);
        }
      });
    });

    if (imageTasks.length) await Promise.all(imageTasks);

    const outBytes = await outDoc.save();
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (currentFileName || 'document.pdf').replace(/\.pdf$/i, '') + '-annotated.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1200);
    showToast('Saved ✔️', 'ok');
  } catch (err) {
    console.error('Save failed:', err);
    showToast('Could not save PDF', 'err');
  }
}