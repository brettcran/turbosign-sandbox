// lib/app/app.mjs
// ===== 1) PDF.js (ESM) + worker =====
import * as pdfjsLib from '../../build/pdf.mjs';

try {
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
    new URL('../../build/pdf.worker.mjs', import.meta.url),
    { type: 'module' }
  );
} catch {
  // Fallback (older Safari). Worker is ESM; some engines need this hint anyway.
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../build/pdf.worker.mjs', import.meta.url).toString();
}

// ===== 2) Tiny helpers =====
const $  = (sel, root=document) => root.querySelector(sel);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const toast = (msg, kind='ok', t=2000) => {
  const n = $('#toast'); if (!n) return;
  n.textContent = msg; n.className = ''; n.classList.add('show', kind);
  clearTimeout(n._t); n._t = setTimeout(()=>{ n.className=''; }, t);
};

const refs = {
  stage: $('#pdf-stage'),
  scroll: $('#pdf-scroll'),
  container: $('#pdf-container'),
  fileInput: $('#file-input'),
  openBtn: document.querySelector('[data-act="open"]'),
  textBtn: document.querySelector('[data-act="text"]'),
  stampBtn: document.querySelector('[data-act="stamp"]'),
  signBtn:  document.querySelector('[data-act="sign"]'),
  undoBtn:  document.querySelector('[data-act="undo"]'),
  redoBtn:  document.querySelector('[data-act="redo"]'),
  helpBtn:  document.querySelector('[data-act="help"]'),
  settingsBtn: document.querySelector('[data-act="settings"]') || null,

  // signature modal
  sigModal: $('#sign-modal'),
  sigPad:   $('#sig-pad'),
  sigUse:   $('#sig-use'),
  sigClear: $('#sig-clear'),
  sigCancel:$('#sig-cancel'),
};

let CURRENT_PDF = { bytes:null, wraps:[], vpCSSByPage:[] , filename:null };

// ===== 3) Zoom manager (pinch + wheel + double‑tap) =====
class Zoom {
  constructor(container, scrollElem){
    this.container = container;
    this.scroll = scrollElem;
    this.scale = 1;
    this.min = 0.6;
    this.max = 3;
    this._pinching = false;
    this._lastDist = 0;
    this._cx = 0; this._cy = 0; // content px at gesture center
    this.container.style.transformOrigin = '0 0';
    // Input hooks
    on(scrollElem, 'wheel', (e)=>this._onWheel(e), { passive:false });
    on(scrollElem, 'dblclick', (e)=>this._zoomAt(e.clientX, e.clientY, 1.2));
    on(scrollElem, 'pointerdown', (e)=>this._onPointerDown(e));
    on(scrollElem, 'pointermove', (e)=>this._onPointerMove(e));
    on(scrollElem, 'pointerup',   (e)=>this._onPointerUp(e));
    this._pts = new Map();
  }
  fitToWidth(){
    // compute based on first page width vs stage width
    const first = this.container.querySelector('.page-wrap');
    if (!first) return;
    const stageW = this.scroll.clientWidth - 24; // some gutter
    const target = Math.min(1.0, stageW / first.getBoundingClientRect().width);
    this.setScale(target, 0, 0, false);
    // center horizontally
    this.scroll.scrollLeft = Math.max(0, (this.container.getBoundingClientRect().width*target - this.scroll.clientWidth)/2);
  }
  setScale(newScale, clientX, clientY, keepCenter=true){
    newScale = Math.max(this.min, Math.min(this.max, newScale));
    if (newScale === this.scale) return;

    // figure out content coords at the focus point
    const rect = this.container.getBoundingClientRect();
    const sx = (clientX - rect.left + this.scroll.scrollLeft) / this.scale;
    const sy = (clientY - rect.top  + this.scroll.scrollTop ) / this.scale;

    this.scale = newScale;
    this.container.style.transform = `scale(${this.scale})`;

    if (keepCenter){
      const nx = sx * this.scale - (clientX - rect.left);
      const ny = sy * this.scale - (clientY - rect.top);
      this.scroll.scrollLeft = nx;
      this.scroll.scrollTop  = ny;
    }
  }
  _onWheel(e){
    if (!(e.ctrlKey || e.metaKey)) return; // make pinch trackpad natural (ctrl/⌘+wheel to zoom)
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    this.setScale(this.scale * factor, e.clientX, e.clientY, true);
  }
  _onPointerDown(e){
    this._pts.set(e.pointerId, e);
    if (this._pts.size === 2){
      this._pinching = true;
      const [a,b] = [...this._pts.values()];
      this._lastDist = Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY);
      this._cx = (a.clientX + b.clientX)/2;
      this._cy = (a.clientY + b.clientY)/2;
    }
  }
  _onPointerMove(e){
    if (!this._pts.has(e.pointerId)) return;
    this._pts.set(e.pointerId, e);
    if (this._pinching && this._pts.size === 2){
      const [a,b] = [...this._pts.values()];
      const dist = Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY);
      if (this._lastDist){
        const factor = dist / this._lastDist;
        this.setScale(this.scale * factor, this._cx, this._cy, true);
      }
      this._lastDist = dist;
    }
  }
  _onPointerUp(e){
    this._pts.delete(e.pointerId);
    if (this._pts.size < 2){ this._pinching = false; this._lastDist = 0; }
  }
  _zoomAt(x,y,f){ this.setScale(this.scale * f, x, y, true); }
}
const zoom = new Zoom(refs.container, refs.scroll);

// ===== 4) Annotations (text, stamp, signature; drag + resize) =====
class Annotations {
  constructor(container){
    this.container = container;
    this.mode = null; // 'text' | 'stamp' | 'sign' | null
    this.history = []; this.redoStack = [];
    this.overlays = []; this.selected = null;
    this.textStyle = { size:16, color:'#000', bold:false, italic:false, family:'Arial, sans-serif' };

    // drag / resize state
    this.drag = { el:null, overlay:null, dx:0, dy:0 };
    this.resize = { el:null, overlay:null, startW:0, startH:0, sx:0, sy:0 };

    on(document, 'pointermove', (e)=>this._onMove(e), { passive:false });
    on(document, 'pointerup',   (e)=>this._onUp(e));
  }
  setMode(m){ this.mode = m; this._select(null); }

  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove());
    this.overlays = [];
    wrapInfos.forEach((info, pageIndex)=>{
      const ov = document.createElement('div');
      ov.className = 'overlay';
      info.wrap.appendChild(ov);

      // click clearing
      on(ov, 'pointerdown', (e)=>{ if (e.target === ov) this._select(null); }, { passive:true });

      // add stamp (single tap/click)
      on(ov, 'pointerdown', (e)=> {
        if (this.mode !== 'stamp') return;
        const {x,y} = this._pos(ov,e);
        this._addStamp(ov,x,y);
      }, { passive:true });

      // add text (double‑click/ double‑tap – handled in mobile-friendly code earlier)
      on(ov, 'dblclick', (e)=> {
        if (this.mode !== 'text') return;
        const {x,y} = this._pos(ov,e);
        this._addText(ov,x,y,true);
      });

      // signature placement happens after drawing via modal
      this.overlays.push(ov);
    });
  }
  useSignature(dataURL){
    // place signature in the center of the current viewport
    const ov = this._overlayAtViewportCenter();
    if (!ov) return;
    const rect = ov.getBoundingClientRect();
    const x = rect.width * 0.5;
    const y = rect.height* 0.5;
    this._addSignature(ov, x, y, dataURL);
  }

  // ---- create elements
  _addText(overlay,x,y,focus){
    const el = document.createElement('div');
    el.className = 'anno text';
    el.contentEditable = 'true';
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    el.style.color      = this.textStyle.color;
    el.style.fontSize   = `${Math.max(16,this.textStyle.size)}px`;
    el.style.fontWeight = this.textStyle.bold ? '700':'400';
    el.style.fontStyle  = this.textStyle.italic ? 'italic':'normal';
    el.style.fontFamily = this.textStyle.family;

    overlay.appendChild(el);
    this._wireAnno(el, overlay, { resizable:true });
    if (focus){ this._focus(el); }
    this._recordAdd(overlay, el);
  }
  _addStamp(overlay,x,y){
    const el = document.createElement('div');
    el.className = 'anno stamp';
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    el.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M4 12l4 4 12-12"/></svg>`;
    overlay.appendChild(el);
    this._wireAnno(el, overlay, { resizable:false });
    this._recordAdd(overlay, el);
  }
  _addSignature(overlay,x,y,dataURL){
    const el = document.createElement('div');
    el.className = 'anno sign';
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    const img = new Image();
    img.draggable = false;
    img.src = dataURL;
    img.style.display='block';
    img.style.maxWidth = '100%';
    el.appendChild(img);
    overlay.appendChild(el);
    this._wireAnno(el, overlay, { resizable:true });
    // default size
    img.onload = ()=> {
      const maxW = Math.min(overlay.clientWidth*0.5, img.naturalWidth);
      const ratio = maxW / img.naturalWidth;
      img.width  = maxW;
      img.height = img.naturalHeight * ratio;
    };
    this._recordAdd(overlay, el);
  }

  _wireAnno(el, overlay, {resizable}){
    // select and drag
    on(el, 'pointerdown', (e)=>{
      if (el.classList.contains('text') && document.activeElement === el) { this._select(el); return; }
      const {x,y} = this._pos(overlay,e);
      const left = parseFloat(el.style.left)||0;
      const top  = parseFloat(el.style.top)||0;
      this.drag = { el, overlay, dx:x-left, dy:y-top };
      $('#pdf-scroll').style.touchAction = 'none';
      el.setPointerCapture?.(e.pointerId);
      this._select(el);
      e.preventDefault();
    }, { passive:false });

    // allow entering text edit by dblclick on text
    if (el.classList.contains('text')) {
      on(el, 'dblclick', ()=>{ this._focus(el); this._select(el); });
    }

    // resize handle
    if (resizable){
      const h = document.createElement('div');
      h.className = 'handle br';
      el.appendChild(h);
      on(h, 'pointerdown', (e)=>{
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        this.resize = { el, overlay, startW:r.width, startH:r.height, sx:e.clientX, sy:e.clientY };
        $('#pdf-scroll').style.touchAction = 'none';
        h.setPointerCapture?.(e.pointerId);
      }, { passive:false });
    }
  }

  _onMove(e){
    // drag
    if (this.drag.el){
      const {x,y} = this._pos(this.drag.overlay,e);
      let nx = x - this.drag.dx, ny = y - this.drag.dy;
      const or = this.drag.overlay.getBoundingClientRect();
      const r  = this.drag.el.getBoundingClientRect();
      nx = Math.max(0, Math.min(nx, or.width - r.width));
      ny = Math.max(0, Math.min(ny, or.height- r.height));
      this.drag.el.style.left = `${nx}px`;
      this.drag.el.style.top  = `${ny}px`;
      e.preventDefault(); return;
    }
    // resize
    if (this.resize.el){
      const dx = (e.clientX - this.resize.sx);
      const dy = (e.clientY - this.resize.sy);
      const w = Math.max(24, this.resize.startW + dx);
      const h = Math.max(16, this.resize.startH + dy);
      const el = this.resize.el;
      if (el.classList.contains('text')){
        // scale font by height delta (roughly)
        const cur = parseFloat(getComputedStyle(el).fontSize)||16;
        const scale = h / this.resize.startH;
        el.style.fontSize = `${Math.max(16, cur*scale)}px`;
      } else {
        // signature image
        const img = el.querySelector('img'); if (img){ img.style.width = w+'px'; img.style.height = 'auto'; }
        // stamp could be scaled via transform; we left stamps non-resizable for simplicity
      }
      e.preventDefault();
    }
  }
  _onUp(e){
    if (this.drag.el){ try{ this.drag.el.releasePointerCapture?.(e.pointerId) }catch{}; this.drag={el:null,overlay:null,dx:0,dy:0}; }
    if (this.resize.el){ try{ this.resize.el.releasePointerCapture?.(e.pointerId) }catch{}; this.resize={el:null,overlay:null,startW:0,startH:0,sx:0,sy:0}; }
    $('#pdf-scroll').style.touchAction = 'pan-y';
  }

  undo(){ const last=this.history.pop(); if (!last) return; if (last.el?.parentNode){ last.el.parentNode.removeChild(last.el); if (this.selected===last.el) this._select(null); this.redoStack.push(last);} }
  redo(){ const next=this.redoStack.pop(); if (!next) return; if (next.el){ next.overlay.appendChild(next.el); this.history.push(next);} }
  _recordAdd(overlay, el){ this.history.push({ type:'add', overlay, el }); this.redoStack.length=0; }

  _select(el){ if (this.selected) this.selected.classList.remove('selected'); this.selected = el; if (el) el.classList.add('selected'); }
  _focus(el){
    el.focus();
    const sel = getSelection(); const range = document.createRange();
    range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
  }
  _pos(overlay, e){ const r=overlay.getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top }; }
  _overlayAtViewportCenter(){
    const midX = refs.scroll.scrollLeft + refs.scroll.clientWidth/2;
    const midY = refs.scroll.scrollTop  + refs.scroll.clientHeight/2;
    // find overlay whose page contains that point
    return this.overlays.find(ov => {
      const r = ov.getBoundingClientRect();
      const c = refs.container.getBoundingClientRect();
      const left = r.left - c.left + refs.scroll.scrollLeft;
      const top  = r.top  - c.top  + refs.scroll.scrollTop;
      return midX>=left && midX<=left+r.width && midY>=top && midY<=top+r.height;
    }) || this.overlays[0];
  }
}
const ann = new Annotations(refs.container);

// ===== 5) Signature Pad =====
class SigPad {
  constructor(canvas, modal){
    this.canvas = canvas; this.modal = modal; this.ctx = canvas.getContext('2d');
    this.clear();
    this.drawing = false; this.last = null;
    const start = (x,y)=>{ this.drawing=true; this.last={x,y}; };
    const move  = (x,y)=>{ if(!this.drawing) return; this.ctx.lineTo(x,y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(x,y); };
    const end   = ()=>{ this.drawing=false; this.ctx.beginPath(); };

    const off = (ev)=>{ const r = canvas.getBoundingClientRect(); return { x:(ev.clientX - r.left) * (canvas.width/r.width), y:(ev.clientY - r.top) * (canvas.height/r.height) }; };
    on(canvas,'pointerdown',(e)=>{ canvas.setPointerCapture?.(e.pointerId); const p=off(e); start(p.x,p.y); },{passive:false});
    on(canvas,'pointermove',(e)=>{ const p=off(e); move(p.x,p.y); },{passive:false});
    on(canvas,'pointerup',  ()=> end());
  }
  open(){ this.modal.classList.add('show'); }
  close(){ this.modal.classList.remove('show'); }
  clear(){
    const dpr = Math.max(1, window.devicePixelRatio||1);
    this.canvas.width = 500 * dpr; this.canvas.height = 200 * dpr;
    this.canvas.style.width='500px'; this.canvas.style.height='200px';
    const ctx = this.ctx;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
    ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = '#000'; ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.beginPath();
  }
  dataURL(){ return this.canvas.toDataURL('image/png'); }
}
const sig = new SigPad(refs.sigPad, refs.sigModal);

// ===== 6) PDF rendering (returns wrap + vpCSS for mapping) =====
async function renderPdfFromFile(file, container, scale=1.5){
  const bytes = new Uint8Array(await file.arrayBuffer());
  CURRENT_PDF.bytes = bytes;
  CURRENT_PDF.filename = file.name || 'document.pdf';
  return renderPdfFromData(bytes, container, scale);
}
async function renderPdfFromData(bytes, container, scale=1.5){
  container.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio||1));

  for (let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const vpCSS = page.getViewport({ scale });
    const vpDev = page.getViewport({ scale: scale * ratio });

    const wrap = document.createElement('div'); wrap.className='page-wrap';
    const canvas = document.createElement('canvas'); canvas.className='pdfpage';
    canvas.width = Math.floor(vpDev.width); canvas.height = Math.floor(vpDev.height);
    canvas.style.width = vpCSS.width+'px'; canvas.style.height = vpCSS.height+'px';

    wrap.appendChild(canvas); container.appendChild(wrap);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vpDev }).promise;

    CURRENT_PDF.wraps.push(wrap); CURRENT_PDF.vpCSSByPage.push({ width: vpCSS.width, height: vpCSS.height });
  }
  // after first layout, set zoom fit and center
  requestAnimationFrame(()=> zoom.fitToWidth());
  return CURRENT_PDF.wraps.map((wrap, idx)=>({ wrap, vpCSS: CURRENT_PDF.vpCSSByPage[idx] }));
}

// ===== 7) SAVE as flattened PDF (client‑side, all platforms) =====
async function saveFlattened(){
  if (!CURRENT_PDF.bytes){ toast('Open a PDF first', 'err'); return; }
  // Lazy-load pdf-lib (ESM) from CDN
  const { PDFDocument, rgb, StandardFonts } = await import('https://cdn.skypack.dev/pdf-lib');

  const pdf = await PDFDocument.load(CURRENT_PDF.bytes);
  const pages = pdf.getPages();

  // Walk overlays per page, draw into PDF coordinates
  CURRENT_PDF.wraps.forEach((wrap, idx)=>{
    const page = pages[idx];
    const overlay = wrap.querySelector('.overlay'); if (!overlay) return;
    const pageSize = { w: page.getWidth(), h: page.getHeight() };
    const vp = CURRENT_PDF.vpCSSByPage[idx];

    overlay.querySelectorAll('.anno').forEach(el=>{
      const r = el.getBoundingClientRect();
      const or = overlay.getBoundingClientRect();

      const xCSS = (r.left - or.left);
      const yCSS = (r.top  - or.top);
      const wCSS = r.width;
      const hCSS = r.height;

      // map CSS pixels -> PDF units
      const fx = pageSize.w / vp.width;
      const fy = pageSize.h / vp.height;

      const x = xCSS * fx;
      const y = pageSize.h - (yCSS + hCSS) * fy;
      const w = Math.max(1, wCSS * fx);
      const h = Math.max(1, hCSS * fy);

      if (el.classList.contains('text')){
        const fontSize = parseFloat(getComputedStyle(el).fontSize)||16;
        const color = getComputedStyle(el).color;
        const [rR,gG,bB] = (color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
        const bold = (parseInt(getComputedStyle(el).fontWeight,10) || 400) >= 600;
        const italic = getComputedStyle(el).fontStyle === 'italic';
        // pdf-lib doesn't do italic automatically; use StandardFonts
        const fontName = bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
        pdf.embedFont(fontName).then(font=>{
          page.drawText(el.textContent || '', {
            x, y, size: fontSize*fx, font, color: rgb(rR,gG,bB)
          });
        });
      } else if (el.classList.contains('stamp')){
        // draw a "check" using two lines
        const stroke = rgb(0,0,0);
        const x1=x, y1=y + h*0.45, x2 = x + w*0.35, y2 = y + h*0.15, x3 = x + w, y3 = y + h*0.85;
        page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:2*fx, color:stroke });
        page.drawLine({ start:{x:x2,y:y2}, end:{x:x3,y:y3}, thickness:2*fx, color:stroke });
      } else if (el.classList.contains('sign')){
        const img = el.querySelector('img'); if (!img) return;
        // embed PNG
        // Fetch the dataURL -> Uint8Array
        const dataURL = img.src;
        const bin = atob(dataURL.split(',')[1]);
        const bytes = new Uint8Array(bin.length); for (let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i);
        pdf.embedPng(bytes).then(png=>{
          page.drawImage(png, { x, y, width:w, height:h });
        });
      }
    });
  });

  // Wait a tick for fonts/images embeds to schedule (very light heuristic)
  await new Promise(r=>setTimeout(r,0));

  const out = await pdf.save();
  const defaultName = (CURRENT_PDF.filename || 'document.pdf').replace(/\.pdf$/i,'') + '-signed.pdf';

  // Try File System Access API first
  if ('showSaveFilePicker' in window){
    try{
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultName,
        types:[{ description:'PDF', accept:{ 'application/pdf': ['.pdf'] } }]
      });
      const w = await handle.createWritable();
      await w.write(out);
      await w.close();
      toast('Saved ✔️');
      return;
    }catch(e){ /* user canceled or not allowed -> fall through to download */ }
  }
  // Fallback: download
  const blob = new Blob([out], { type:'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=> URL.revokeObjectURL(a.href), 1500);
  toast('Downloaded ✔️');
}

// ===== 8) Wire UI =====
function ensureSettingsBtn(){
  if (!refs.settingsBtn){
    const tb = $('#toolbar');
    const btn = document.createElement('button');
    btn.className='btn'; btn.dataset.act='settings'; btn.title='Text Settings';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" style="stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 3.3l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .64.38 1.22.97 1.46.17.07.35.1.53.1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
    tb.appendChild(btn);
    refs.settingsBtn = btn;
  }
}
ensureSettingsBtn();

on(refs.openBtn, 'click', ()=> refs.fileInput.click());
on(refs.fileInput, 'change', async (e)=>{
  const file = e.target.files?.[0]; if (!file) return;
  try{
    const wraps = await renderPdfFromFile(file, refs.container, 1.5);
    const infos = wraps.map((wrap, i)=>({ wrap, vpCSS: CURRENT_PDF.vpCSSByPage[i] }));
    ann.attachOverlays(infos);
    toast('PDF loaded ✔️');
  }catch(err){ console.error(err); toast('Could not open PDF', 'err'); }
});

// Mode buttons
on(refs.textBtn,  'click', ()=>{ ann.setMode(ann.mode==='text'?null:'text');  toast(ann.mode?'Text tool: dbl‑click':'Tool off'); });
on(refs.stampBtn, 'click', ()=>{ ann.setMode(ann.mode==='stamp'?null:'stamp'); toast(ann.mode?'Stamp tool: tap to place':'Tool off'); });
on(refs.signBtn,  'click', ()=>{ ann.setMode(null); sig.open(); });
on(refs.undoBtn,  'click', ()=> ann.undo());
on(refs.redoBtn,  'click', ()=> ann.redo());
on(refs.helpBtn,  'click', ()=> toast('Pinch to zoom. 📂 open a PDF. Text: dbl‑click → type; Stamp: tap; Signature: draw → Use. Drag/resize elements. Save via toolbar.', 'ok', 3000));

// Signature modal actions
const closeSig = ()=> sig.close();
on(refs.sigUse,   'click', ()=>{ ann.useSignature(sig.dataURL()); closeSig(); });
on(refs.sigClear, 'click', ()=> sig.clear());
on(refs.sigCancel,'click', closeSig);

// ===== 9) Save button wiring (optional: add a button with data-act="save") =====
const saveBtn = document.querySelector('[data-act="save"]');
on(saveBtn, 'click', saveFlattened);
