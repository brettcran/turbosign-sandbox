// ============================
// TurboSign App.mjs (v4.1 ESM)
// ============================

// --- Imports ---
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.min.mjs';

// Feather icons (ESM, with fallback)
import feather from 'https://cdn.jsdelivr.net/npm/feather-icons@4.29.0/dist/feather.min.js?module';
document.addEventListener('DOMContentLoaded', () => {
  try { feather.replace(); } catch (e) {}
});
if (!feather || typeof feather.replace !== 'function') {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/feather-icons@4.29.0/dist/feather.min.js';
  s.onload = () => window.feather?.replace?.();
  document.head.appendChild(s);
}

// pdf-lib ESM (loaded on demand)
async function loadPdfLib() {
  const mod = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
  return {
    PDFDocument: mod.PDFDocument,
    rgb: mod.rgb,
    StandardFonts: mod.StandardFonts
  };
}

// --- Globals ---
let pdfDoc = null;
let currentScale = 1.0;
let currentFileName = null;
let annotations = [];
let activeTool = null;
let currentSigDataUrl = null;

// --- UI Elements ---
const fileInput = document.getElementById('file-input');
const pdfContainer = document.getElementById('pdf-container');
const toastEl = document.getElementById('toast');
const restoreBanner = document.getElementById('restore-banner');

// --- Toast Helper ---
function showToast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className = type ? `show ${type}` : 'show';
  setTimeout(() => { toastEl.className = ''; }, 2200);
}

// --- File Open ---
document.querySelector('[data-act="open"]').addEventListener('click', () => {
  fileInput.click();
});
fileInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  currentFileName = file.name;
  const data = new Uint8Array(await file.arrayBuffer());
  renderPdfFromData(data);
});

// --- Render PDF ---
async function renderPdfFromData(data) {
  try {
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  } catch (err) {
    showToast("❌ Couldn't open PDF", 'err');
    console.error(err);
    return;
  }
  pdfContainer.innerHTML = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: currentScale });
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = i;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdfpage';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    wrap.appendChild(canvas);
    wrap.appendChild(overlay);
    pdfContainer.appendChild(wrap);
  }
  showToast('✅ PDF loaded', 'ok');
}

// --- Toolbar Actions ---
document.getElementById('toolbar').addEventListener('click', e => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'open') return;

  if (act === 'sign') {
    document.getElementById('sign-modal').classList.add('show');
    return;
  }
  if (act === 'save') {
    saveFlattened();
    return;
  }

  activeTool = act;
  showToast(`Tool: ${act}`);
});

// --- Double-tap for text / signature ---
pdfContainer.addEventListener('dblclick', e => {
  if (!activeTool) return;
  const wrap = e.target.closest('.page-wrap');
  if (!wrap) return;
  const pageIndex = parseInt(wrap.dataset.page);

  const rect = wrap.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (activeTool === 'text') {
    addAnnotation('text', { x, y, page: pageIndex }, 'Tap to type');
  } else if (activeTool === 'stamp') {
    addAnnotation('stamp', { x, y, page: pageIndex }, null);
  } else if (activeTool === 'sign' && currentSigDataUrl) {
    addAnnotation('sign', { x, y, page: pageIndex }, currentSigDataUrl);
  }
});

// --- Add Annotation ---
function addAnnotation(type, pos, content) {
  const wrap = pdfContainer.querySelector(`.page-wrap[data-page="${pos.page}"]`);
  if (!wrap) return;
  const anno = document.createElement('div');
  anno.className = `anno ${type}`;
  anno.style.left = pos.x + 'px';
  anno.style.top = pos.y + 'px';

  if (type === 'text') {
    anno.contentEditable = true;
    anno.textContent = content || '';
  } else if (type === 'stamp') {
    anno.innerHTML = feather.icons['check'].toSvg();
  } else if (type === 'sign') {
    const img = document.createElement('img');
    img.src = content;
    anno.appendChild(img);

    // resize handle
    const handle = document.createElement('div');
    handle.className = 'handle br';
    anno.appendChild(handle);
    makeResizable(anno, handle);
  }

  wrap.appendChild(anno);
  makeDraggable(anno);
  annotations.push({ type, pos, content });
}

// --- Drag/Resize Helpers ---
function makeDraggable(el) {
  let offsetX, offsetY, dragging = false;
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('handle')) return;
    dragging = true;
    offsetX = e.offsetX;
    offsetY = e.offsetY;
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

// --- Signature Modal ---
const sigPad = document.getElementById('sig-pad');
const sigCtx = sigPad.getContext('2d');
sigCtx.fillStyle = '#fff'; // white background
sigCtx.fillRect(0, 0, sigPad.width, sigPad.height);
let drawing = false;
sigPad.addEventListener('pointerdown', e => {
  drawing = true;
  sigCtx.beginPath();
  sigCtx.moveTo(e.offsetX, e.offsetY);
});
sigPad.addEventListener('pointermove', e => {
  if (!drawing) return;
  sigCtx.lineTo(e.offsetX, e.offsetY);
  sigCtx.stroke();
});
sigPad.addEventListener('pointerup', () => { drawing = false; });

document.getElementById('sig-use').onclick = () => {
  currentSigDataUrl = sigPad.toDataURL('image/png');
  document.getElementById('sign-modal').classList.remove('show');
  showToast('Signature ready', 'ok');
};
document.getElementById('sig-clear').onclick = () => {
  sigCtx.fillStyle = '#fff';
  sigCtx.fillRect(0, 0, sigPad.width, sigPad.height);
};
document.getElementById('sig-cancel').onclick = () => {
  document.getElementById('sign-modal').classList.remove('show');
};

// --- Save Flattened ---
async function saveFlattened() {
  if (!pdfDoc) return;
  const { PDFDocument } = await loadPdfLib();
  const origBytes = await pdfDoc.getData();
  const newPdf = await PDFDocument.load(origBytes);

  // TODO: actually flatten annotations onto pages (text, stamp, sign)
  // For now: just re-save
  const outBytes = await newPdf.save();
  const blob = new Blob([outBytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = currentFileName || 'annotated.pdf';
  a.click();
  showToast('PDF saved', 'ok');
}