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
  if (!t) return;
  t.textContent = msg; t.className = ''; t.classList.add('show', kind);
  clearTimeout(t._timer); t._timer = setTimeout(()=>{ t.className=''; }, timeout);
};

// Ensure a settings button exists (inject if missing)
(function ensureSettingsBtn(){
  const tb = $('#toolbar');
  if (!tb) return;
  let settingsBtn = tb.querySelector('[data-act="settings"]');
  if (!settingsBtn) {
    settingsBtn = document.createElement('button');
    settingsBtn.className = 'btn';
    settingsBtn.dataset.act = 'settings';
    settingsBtn.title = 'Text Settings';
    // Feather may or may not have run; inline a tiny gear svg
    settingsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" style="stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 3.3l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .64.38 1.22.97 1.46.17.07.35.1.53.1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
    tb.insertBefore(settingsBtn, tb.lastElementChild); // before Save/last button if present
    try { window.feather?.replace?.() } catch(e) {}
  }
})();

// 3) Minimal annotation manager (dblclick to add text; drag to move; stamp checkmark black)
class Annotations {
  constructor(container){
    this.container = container;
    this.mode = null;           // 'text' | 'stamp' | null
    this.history = [];
    this.redoStack = [];
    this.overlays = [];
    this.selectedEl = null;

    // text defaults (settings panel controls these)
    this.textStyle = {
      size: 16,
      color: '#000000',
      bold: false,
      italic: false,
      family: 'Arial, sans-serif',
    };

    // drag state
    this.drag = { el:null, dx:0, dy:0, overlay:null };
    on(document, 'pointermove', (e)=>this._onDragMove(e));
    on(document, 'pointerup',   (e)=>this._onDragEnd(e));
  }

  setMode(m){
    this.mode = m; 
    this._clearSelectionOutline();
  }

  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove());
    this.overlays = [];
    wrapInfos.forEach((info) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      info.wrap.appendChild(ov);

      // STAMP: single click place
      on(ov, 'pointerdown', (e) => {
        if (this.mode !== 'stamp') return;
        const { x, y } = this._posInOverlay(e, ov);
        this._addStamp(ov, x, y);
      });

      // TEXT: double-click to place
      on(ov, 'dblclick', (e) => {
        if (this.mode !== 'text') return;
        const { x, y } = this._posInOverlay(e, ov);
        this._addText(ov, x, y);
      });

      // click inside overlay clears selection if clicking empty space
      on(ov, 'pointerdown', (e) => {
        if (e.target === ov) this._select(null);
      });

      this.overlays.push(ov);
    });
  }

  // ----- UNDO/REDO
  undo(){
    const last = this.history.pop();
    if (!last) return;
    if (last.type === 'add' && last.el?.parentNode){
      last.el.parentNode.removeChild(last.el);
      if (this.selectedEl === last.el) this._select(null);
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

  // ----- POINTER HELPERS
  _posInOverlay(e, overlay){
    const r = overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ----- CREATE TEXT
  _addText(overlay, x, y){
    const el = document.createElement('div');
    el.className = 'anno text';
    el.contentEditable = 'true';
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;

    // apply current text settings
    el.style.color = this.textStyle.color;
    el.style.fontSize = `${this.textStyle.size}px`;
    el.style.fontFamily = this.textStyle.family;
    el.style.fontWeight = this.textStyle.bold ? '700' : '400';
    el.style.fontStyle  = this.textStyle.italic ? 'italic' : 'normal';

    // start empty; focus caret; select for settings
    overlay.appendChild(el);
    this._wireAnnoEvents(el, overlay);
    el.focus();
    this._select(el);

    // record history
    this._recordAdd(overlay, el);
  }

  // ----- CREATE STAMP (black checkmark)
  _addStamp(overlay, x, y){
    const el = document.createElement('div');
    el.className = 'anno stamp';
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    el.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18"
           style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round">
        <path d="M4 12l4 4 12-12"></path>
      </svg>`;
    overlay.appendChild(el);
    this._wireAnnoEvents(el, overlay);
    this._recordAdd(overlay, el);
  }

  _recordAdd(overlay, el){
    this.history.push({ type:'add', overlay, el });
    this.redoStack.length = 0;
  }

  // ----- SELECT & DRAG
  _wireAnnoEvents(el, overlay){
    // select on click (but let text edit when focused)
    on(el, 'pointerdown', (e) => {
      // if text and currently focused (editing), don't start drag
      if (el.classList.contains('text') && document.activeElement === el) {
        this._select(el);
        return;
      }
      // start drag
      const { x, y } = this._posInOverlay(e, overlay);
      const r = el.getBoundingClientRect();
      const or = overlay.getBoundingClientRect();
      this.drag.el = el;
      this.drag.overlay = overlay;
      // compute offset from element's current position
      const left = parseFloat(el.style.left) || 0;
      const top  = parseFloat(el.style.top)  || 0;
      this.drag.dx = x - left;
      this.drag.dy = y - top;
      el.setPointerCapture?.(e.pointerId);
      this._select(el);
      e.preventDefault();
    });

    // blur removes selection outline but keeps element
    on(el, 'blur', () => {
      // keep selection state; outline handled dynamically
      this._updateSelectionOutline();
    });

    // allow clicking to focus text to type
    if (el.classList.contains('text')) {
      on(el, 'dblclick', () => {
        el.focus();
        this._select(el);
      });
      // typing should not drag
      on(el, 'keydown', () => {
        // no-op; just ensures focus path
      });
    }
  }

  _onDragMove(e){
    if (!this.drag.el) return;
    const overlay = this.drag.overlay;
    const { x, y } = this._posInOverlay(e, overlay);
    let nx = x - this.drag.dx;
    let ny = y - this.drag.dy;

    // keep inside overlay bounds
    const or = overlay.getBoundingClientRect();
    const r  = this.drag.el.getBoundingClientRect();
    const maxX = or.width  - r.width;
    const maxY = or.height - r.height;
    nx = Math.max(0, Math.min(nx, maxX));
    ny = Math.max(0, Math.min(ny, maxY));

    this.drag.el.style.left = `${nx}px`;
    this.drag.el.style.top  = `${ny}px`;
  }

  _onDragEnd(e){
    if (!this.drag.el) return;
    try { this.drag.el.releasePointerCapture?.(e.pointerId) } catch(_) {}
    this.drag.el = null; this.drag.overlay = null;
  }

  _select(el){
    this.selectedEl = el;
    this._updateSelectionOutline();
    // reflect into settings UI
    if (el && el.classList.contains('text')) {
      Settings.syncFromElement(el);
    }
  }
  _clearSelectionOutline(){
    this.container.querySelectorAll('.anno').forEach(n => n.style.outline = '');
  }
  _updateSelectionOutline(){
    this._clearSelectionOutline();
    if (this.selectedEl) {
      this.selectedEl.style.outline = '1.5px dashed #4ea3ff';
      this.selectedEl.style.outlineOffset = '2px';
    }
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

// 5) Settings UI (floating panel) — controls text style
const Settings = (() => {
  let panel, sizeInp, colorInp, boldInp, italicInp, familySel, toggleBtn;
  const state = {
    size: 16, color: '#000000', bold: false, italic: false, family: 'Arial, sans-serif'
  };

  function build(){
    panel = document.createElement('div');
    panel.style.position = 'fixed';
    panel.style.right = '12px';
    panel.style.bottom = '88px';
    panel.style.zIndex = '50';
    panel.style.background = 'rgba(20,24,32,.94)';
    panel.style.border = '1px solid rgba(255,255,255,.14)';
    panel.style.borderRadius = '12px';
    panel.style.padding = '10px';
    panel.style.minWidth = '240px';
    panel.style.display = 'none';
    panel.style.color = '#e9eef5';
    panel.style.font = '13px system-ui, sans-serif';
    panel.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <label style="display:flex;gap:6px;align-items:center">Size
          <input id="ts-size" type="range" min="10" max="48" step="1" value="${state.size}" />
          <span id="ts-size-val" style="width:28px;text-align:right">${state.size}</span>
        </label>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <label style="display:flex;gap:6px;align-items:center">Color
          <input id="ts-color" type="color" value="${state.color}" />
        </label>
        <label style="display:flex;gap:6px;align-items:center">Bold
          <input id="ts-bold" type="checkbox" ${state.bold?'checked':''} />
        </label>
        <label style="display:flex;gap:6px;align-items:center">Italic
          <input id="ts-italic" type="checkbox" ${state.italic?'checked':''} />
        </label>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <label style="display:flex;gap:6px;align-items:center">Font
          <select id="ts-family">
            <option>Arial, sans-serif</option>
            <option>Helvetica, Arial, sans-serif</option>
            <option>Georgia, serif</option>
            <option>Times New Roman, Times, serif</option>
            <option>Courier New, Courier, monospace</option>
            <option>Inter, system-ui, sans-serif</option>
          </select>
        </label>
      </div>
    `;
    document.body.appendChild(panel);

    sizeInp   = $('#ts-size', panel);
    colorInp  = $('#ts-color', panel);
    boldInp   = $('#ts-bold', panel);
    italicInp = $('#ts-italic', panel);
    familySel = $('#ts-family', panel);
    $('#ts-family', panel).value = state.family;

    on(sizeInp,  'input', () => { $('#ts-size-val', panel).textContent = sizeInp.value; apply({size:+sizeInp.value}); });
    on(colorInp, 'input', () => apply({color:colorInp.value}));
    on(boldInp,  'change',()=> apply({bold:boldInp.checked}));
    on(italicInp,'change',()=> apply({italic:italicInp.checked}));
    on(familySel,'change',()=> apply({family:familySel.value}));
  }

  function apply(part){
    Object.assign(state, part);
    // update global defaults
    ann.textStyle = { ...ann.textStyle, ...state };

    // if a text element is selected, live-apply styles to it
    const el = ann.selectedEl;
    if (el && el.classList.contains('text')) {
      el.style.fontSize = `${state.size}px`;
      el.style.color    = state.color;
      el.style.fontWeight = state.bold ? '700':'400';
      el.style.fontStyle  = state.italic? 'italic':'normal';
      el.style.fontFamily = state.family;
    }
  }

  function toggle(){ panel.style.display = panel.style.display==='none' ? 'block' : 'none'; }
  function syncFromElement(el){
    // read styles, update controls (rounded)
    const cs = getComputedStyle(el);
    state.size   = Math.round(parseFloat(cs.fontSize)) || state.size;
    state.color  = rgbToHex(cs.color) || state.color;
    state.bold   = (cs.fontWeight|0) >= 600;
    state.italic = cs.fontStyle === 'italic';
    state.family = cs.fontFamily;

    // push into controls
    $('#ts-size-val', panel).textContent = state.size;
    sizeInp.value = String(state.size);
    colorInp.value = state.color;
    boldInp.checked = state.bold;
    italicInp.checked = state.italic;
    familySel.value = state.family;
    // also update global
    ann.textStyle = { ...state };
  }

  function rgbToHex(rgb){
    const m = rgb.match(/\d+/g);
    if (!m) return '#000000';
    const [r,g,b] = m.map(n=>(+n)|0);
    return '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  }

  return { build, toggle, syncFromElement };
})();

// 6) Wire the page
const refs = {
  fileInput : $('#file-input'),
  openBtn   : document.querySelector('[data-act="open"]'),
  textBtn   : document.querySelector('[data-act="text"]'),
  stampBtn  : document.querySelector('[data-act="stamp"]'),
  undoBtn   : document.querySelector('[data-act="undo"]'),
  redoBtn   : document.querySelector('[data-act="redo"]'),
  helpBtn   : document.querySelector('[data-act="help"]'),
  settingsBtn: document.querySelector('[data-act="settings"]'),
  container : $('#pdf-container')
};

const ann = new Annotations(refs.container);

// Build settings UI & hook button
Settings.build();
on(refs.settingsBtn, 'click', () => Settings.toggle());

// Open → choose → render → overlays
on(refs.openBtn, 'click', () => refs.fileInput?.click());
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
on(refs.textBtn,  'click', () => { ann.setMode(ann.mode==='text'  ? null : 'text');  toast(ann.mode ? 'Text tool (double-click to add)' : 'Tool off'); });
on(refs.stampBtn, 'click', () => { ann.setMode(ann.mode==='stamp' ? null : 'stamp'); toast(ann.mode ? 'Stamp tool (click to add)' : 'Tool off'); });
on(refs.undoBtn,  'click', () => ann.undo());
on(refs.redoBtn,  'click', () => ann.redo());
on(refs.helpBtn,  'click', () => toast('📂 Open a PDF. Text: double-click page, then type; drag to move. Stamp: click page. Undo/Redo supported.'));
