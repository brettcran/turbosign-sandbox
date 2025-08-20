// ---- Imports ----

// PDF.js (ESM)
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.min.js';

// Feather icons (ESM)
import feather from 'https://cdn.jsdelivr.net/npm/feather-icons/dist/feather.esm.js';
document.addEventListener('DOMContentLoaded', () => { feather.replace(); });

// Dynamic import of pdf-lib (ESM)
async function loadPdfLib() {
  const mod = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
  return { PDFDocument: mod.PDFDocument, rgb: mod.rgb, StandardFonts: mod.StandardFonts };
}

// ---- State ----
let pdfDoc = null;
let currentPdfUrl = null;
let annotationsByPage = {};
let activeTool = null;
let signatureDataUrl = null;

// ---- Helpers ----
function showToast(msg, type = 'ok') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `show ${type}`;
  setTimeout(() => toast.className = '', 2200);
}

function makeDraggable(el) {
  let offsetX, offsetY, dragging = false;
  el.addEventListener('pointerdown', e => {
    dragging = true;
    offsetX = e.clientX - el.offsetLeft;
    offsetY = e.clientY - el.offsetTop;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    el.style.left = (e.clientX - offsetX) + 'px';
    el.style.top = (e.clientY - offsetY) + 'px';
  });
  el.addEventListener('pointerup', e => {
    dragging = false;
    el.releasePointerCapture(e.pointerId);
  });
}

function makeResizable(el, handle) {
  let startX, startY, startW, startH, resizing = false;
  handle.addEventListener('pointerdown', e => {
    e.stopPropagation();
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = el.offsetWidth;
    startH = el.offsetHeight;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!resizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    el.style.width = `${startW + dx}px`;
    el.style.height = `${startH + dy}px`;
  });
  handle.addEventListener('pointerup', e => {
    resizing = false;
    handle.releasePointerCapture(e.pointerId);
  });
}

// ---- PDF Rendering ----
async function renderPdfFromData(data) {
  pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  const container = document.getElementById('pdf-container');
  container.innerHTML = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdfpage';
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.position = 'relative';
    wrap.appendChild(canvas);
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.dataset.page = i - 1;
    wrap.appendChild(overlay);
    container.appendChild(wrap);
  }
  showToast('PDF loaded ✔️');
}

// ---- Annotations ----
function addAnnotation(type, content, x, y, pageIndex) {
  const pageWrap = document.querySelectorAll('.page-wrap')[pageIndex];
  const anno = document.createElement('div');
  anno.className = `anno ${type}`;
  anno.style.left = x + 'px';
  anno.style.top = y + 'px';

  if (type === 'text') {
    anno.contentEditable = true;
    anno.innerText = content || '';
  }

  if (type === 'stamp') {
    anno.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
  }

  if (type === 'sign') {
    const img = document.createElement('img');
    img.src = content;
    anno.appendChild(img);
    anno.style.width = '150px';
    anno.style.height = 'auto';
    const handle = document.createElement('div');
    handle.className = 'handle br';
    anno.appendChild(handle);
    makeResizable(anno, handle);
  }

  if (type === 'image') {
    const img = document.createElement('img');
    img.src = content;
    img.style.width = '200px';
    img.style.height = 'auto';
    anno.appendChild(img);
    const handle = document.createElement('div');
    handle.className = 'handle br';
    anno.appendChild(handle);
    makeResizable(anno, handle);
  }

  pageWrap.appendChild(anno);
  makeDraggable(anno);

  if (!annotationsByPage[pageIndex]) annotationsByPage[pageIndex] = [];
  annotationsByPage[pageIndex].push({ type, content, x, y });
}

// ---- File Handling ----
document.querySelector('[data-act="open"]').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  currentPdfUrl = URL.createObjectURL(file);
  const data = await file.arrayBuffer();
  renderPdfFromData(data);
});

// ---- Tools ----
document.querySelectorAll('#toolbar .btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTool = btn.dataset.act;
    if (activeTool === 'sign') {
      document.getElementById('sign-modal').classList.add('show');
    }
    if (activeTool === 'save') saveFlattened();
  });
});

// Double-tap to add text / stamp / signature
document.getElementById('pdf-container').addEventListener('dblclick', e => {
  if (!activeTool) return;
  const pageWrap = e.target.closest('.page-wrap');
  if (!pageWrap) return;
  const pageIndex = [...document.querySelectorAll('.page-wrap')].indexOf(pageWrap);
  const rect = pageWrap.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (activeTool === 'text') addAnnotation('text', '', x, y, pageIndex);
  if (activeTool === 'stamp') addAnnotation('stamp', '', x, y, pageIndex);
  if (activeTool === 'sign' && signatureDataUrl) {
    addAnnotation('sign', signatureDataUrl, x, y, pageIndex);
    activeTool = null;
  }
});

// ---- Signature Modal ----
const sigPad = document.getElementById('sig-pad');
const sigCtx = sigPad.getContext('2d');
sigCtx.fillStyle = '#fff';
sigCtx.fillRect(0, 0, sigPad.width, sigPad.height);

let drawing = false;
sigPad.addEventListener('pointerdown', e => {
  drawing = true;
  sigCtx.moveTo(e.offsetX, e.offsetY);
});
sigPad.addEventListener('pointermove', e => {
  if (!drawing) return;
  sigCtx.lineTo(e.offsetX, e.offsetY);
  sigCtx.stroke();
});
sigPad.addEventListener('pointerup', () => drawing = false);

document.getElementById('sig-use').addEventListener('click', () => {
  signatureDataUrl = sigPad.toDataURL('image/png');
  document.getElementById('sign-modal').classList.remove('show');
  showToast('Signature ready ✔️');
});

document.getElementById('sig-clear').addEventListener('click', () => {
  sigCtx.fillStyle = '#fff';
  sigCtx.fillRect(0, 0, sigPad.width, sigPad.height);
});

document.getElementById('sig-cancel').addEventListener('click', () => {
  document.getElementById('sign-modal').classList.remove('show');
});

// ---- Save ----
async function saveFlattened() {
  try {
    const { PDFDocument, rgb } = await loadPdfLib();
    const existingPdfBytes = await fetch(currentPdfUrl).then(res => res.arrayBuffer());
    const pdfDocLib = await PDFDocument.load(existingPdfBytes);

    for (let [pageIndex, annos] of Object.entries(annotationsByPage)) {
      const page = pdfDocLib.getPages()[pageIndex];
      for (const anno of annos) {
        if (anno.type === 'text') {
          page.drawText(anno.content, { x: anno.x, y: anno.y, size: 16, color: rgb(0,0,0) });
        }
        if (anno.type === 'stamp') {
          page.drawText('✓', { x: anno.x, y: anno.y, size: 24, color: rgb(0,0,0) });
        }
        if (anno.type === 'sign' || anno.type === 'image') {
          const imgBytes = await fetch(anno.content).then(r => r.arrayBuffer());
          const embedded = await pdfDocLib.embedPng(imgBytes);
          page.drawImage(embedded, { x: anno.x, y: anno.y, width: 150, height: 80 });
        }
      }
    }

    const pdfBytes = await pdfDocLib.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotated.pdf';
    a.click();
    URL.revokeObjectURL(url);
    showToast('PDF saved ✔️');
  } catch (err) {
    console.error(err);
    showToast('Save failed ❌', 'err');
  }
}