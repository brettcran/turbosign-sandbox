// lib/app/app.mjs
// 1) PDF.js ESM import + module worker
import * as pdfjsLib from '../../build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
  new URL('../../build/pdf.worker.mjs', import.meta.url),
  { type: 'module' }
);

// 2) Tiny UI helpers
const $  = (sel, root=document) => root.querySelector(sel);
const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
const toast = (msg, kind='ok', timeout=2200) => {
  const t = $('#toast');
  t.textContent = msg; t.className = ''; t.classList.add('show', kind);
  clearTimeout(t._timer); t._timer = setTimeout(()=>{ t.className=''; }, timeout);
};

// 3) Minimal annotation manager (text + check stamp + undo/redo)
class Annotations {
  constructor(container){
    this.container = container;
    this.mode = null;           // 'text' | 'stamp' | null
    this.history = [];
    this.redoStack = [];
    this.overlays = [];
  }
  setMode(m){ this.mode = m; this.container.querySelectorAll('.anno.text[contenteditable="true"]').forEach(el=>el.blur()); }
  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove());
    this.overlays = [];
    wrapInfos.forEach((info, pageIndex) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.dataset.pageIndex = String(pageIndex);
      info.wrap.appendChild(ov);
      on(ov, 'pointerdown', (e)=>this._onPointerDown(e, ov));
      this.overlays.push(ov);
    });
  }
  undo(){
    const last = this.history.pop();
    if (!last) return;
    if (last.type === 'add' && last.el?.parentNode){
      last.el.parentNode.removeChild(last.el);
      this.redoStack.push(last);
    }
  }
  redo(){
    const next = this.redoStack.pop();
    if (!next) return;
    if (next.type === 'add'){
      next.overlay.appendChild(next.el);
      this.history.push(next);
    }
  }
  _onPointerDown(e, overlay){
    if (!this.mode) return;
    const r = overlay.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (this.mode === 'text') this._addText(overlay, x, y);
    else if (this.mode === 'stamp') this._addStamp(overlay, x, y);
  }
  _addText(overlay, x, y){
    const el = document.createElement('div');
    el.className = 'anno text';
    el.contentEditable = 'true';
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    el.textContent = 'Text';
    overlay.appendChild(el); el.focus();
    this._recordAdd(overlay, el);
  }
  _addStamp(overlay, x, y){
    const el = document.createElement('div');
    el.className = 'anno stamp';
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    el.innerHTML = `
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M8 12l2.5 2.5L16 9"></path>
      </svg>`;
    overlay.appendChild(el);
    this._recordAdd(overlay, el);
  }
  _recordAdd(overlay, el){
    this.history.push({ type:'add', overlay, el });
    this.redoStack.length = 0;
  }
}

// 4) PDF rendering helpers
async function renderPdfFromFile(file, container, scale=1.5){
  const data = new Uint8Array(await file.arrayBuffer());
  return renderPdfFromData(data, container, scale);
}
async function renderPdfFromData(data, container, scale=1.5){
  container.innerHTML = '';
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const wraps = [];

  for (let i=1; i<=pdf.numPages; i++){
    const page  = await pdf.getPage(i);
    const vpCSS = page.getViewport({ scale });
    const vpDev = page.getViewport({ scale: scale * ratio });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';

    const canvas = document.createElement('canvas');
    canvas.className = 'pdfpage';

    canvas.width  = Math.floor(vpDev.width);
    canvas.height = Math.floor(vpDev.height);
    canvas.style.width  = vpCSS.width + 'px';
    canvas.style.height = vpCSS.height + 'px';

    wrap.appendChild(canvas);
    container.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vpDev }).promise;

    wraps.push({ wrap, vpCSS });
  }
  return wraps;
}

// 5) Wire the page
const refs = {
  fileInput : $('#file-input'),
  openBtn   : document.querySelector('[data-act="open"]'),
  textBtn   : document.querySelector('[data-act="text"]'),
  stampBtn  : document.querySelector('[data-act="stamp"]'),
  undoBtn   : document.querySelector('[data-act="undo"]'),
  redoBtn   : document.querySelector('[data-act="redo"]'),
  helpBtn   : document.querySelector('[data-act="help"]'),
  container : $('#pdf-container')
};

const ann = new Annotations(refs.container);

// Open → choose → render → attach overlays
on(refs.openBtn, 'click', () => refs.fileInput.click());
on(refs.fileInput, 'change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const wraps = await renderPdfFromFile(file, refs.container, 1.5);
    ann.attachOverlays(wraps);
    toast('PDF loaded ✔️', 'ok');
  } catch (err) {
    console.error(err);
    toast('Could not open PDF', 'err');
  }
});

// Tools
on(refs.textBtn,  'click', () => { ann.setMode(ann.mode==='text'  ? null : 'text');  toast(ann.mode ? 'Text tool'  : 'Tool off'); });
on(refs.stampBtn, 'click', () => { ann.setMode(ann.mode==='stamp' ? null : 'stamp'); toast(ann.mode ? 'Stamp tool' : 'Tool off'); });
on(refs.undoBtn,  'click', () => ann.undo());
on(refs.redoBtn,  'click', () => ann.redo());
on(refs.helpBtn,  'click', () => toast('📂 Open a PDF. Then click the page with Text or Stamp tool. Undo/Redo supported.'));
