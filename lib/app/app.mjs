// lib/app/app.mjs

// === PDF.js ESM + worker (YOUR TREE: lib/build/) ===
import * as pdfjsLib from '../build/pdf.mjs';
try {
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
    new URL('../build/pdf.worker.mjs', import.meta.url),
    { type: 'module' }
  );
} catch {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../build/pdf.worker.mjs', import.meta.url).toString();
}

// === helpers ===
const $  = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const once = (el, ev, cb, opts) => el && el.addEventListener(ev, function h(e){ el.removeEventListener(ev, h, opts); cb(e); }, opts);
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
const toast = (msg, kind='ok', t=2200) => {
  const n = $('#toast'); if (!n) return;
  n.textContent = msg; n.className = ''; n.classList.add('show', kind);
  clearTimeout(n._t); n._t = setTimeout(()=>{ n.className=''; }, t);
};

// === refs ===
const refs = {
  stage: $('#pdf-stage'),
  scroll: $('#pdf-scroll'),
  container: $('#pdf-container'),
  fileInput: $('#file-input'),
  openBtn:   document.querySelector('[data-act="open"]'),
  textBtn:   document.querySelector('[data-act="text"]'),
  stampBtn:  document.querySelector('[data-act="stamp"]'),
  signBtn:   document.querySelector('[data-act="sign"]'),
  undoBtn:   document.querySelector('[data-act="undo"]'),
  redoBtn:   document.querySelector('[data-act="redo"]'),
  helpBtn:   document.querySelector('[data-act="help"]'),
  settingsBtn: document.querySelector('[data-act="settings"]'),
  saveBtn:     document.querySelector('[data-act="save"]'),
  // signature modal
  sigModal:  $('#sign-modal'),
  sigPad:    $('#sig-pad'),
  sigUse:    $('#sig-use'),
  sigClear:  $('#sig-clear'),
  sigCancel: $('#sig-cancel'),
  // restore banner
  restoreBanner: $('#restore-banner'),
  restoreText:   $('#restore-text'),
  restoreYes:    $('#restore-yes'),
  restoreNo:     $('#restore-no'),
};

let CURRENT_PDF = { bytes:null, filename:null, wraps:[], vpCSSByPage:[] };

// === Zoom (1:1 default; suspend while dragging/resizing) ===
class Zoom {
  constructor(container, scroll){
    this.container = container;
    this.scroll = scroll;
    this.scale = 1; this.min = 0.6; this.max = 3;
    this.suspended = false;
    this._pts = new Map(); this._pinching=false; this._lastDist=0; this._cx=0; this._cy=0;
    container.style.transformOrigin = '0 0';
    on(scroll,'wheel',(e)=>this._onWheel(e),{passive:false});
    on(scroll,'pointerdown',(e)=>this._pd(e));
    on(scroll,'pointermove',(e)=>this._pm(e));
    on(scroll,'pointerup',  (e)=>this._pu(e));
    on(scroll,'pointercancel',(e)=>this._pu(e));
  }
  suspend(v){ this.suspended = !!v; }
  setScale(newScale, clientX, clientY, keepCenter=true){
    newScale = Math.max(this.min, Math.min(this.max, newScale));
    if (newScale === this.scale) return;
    const rect = this.container.getBoundingClientRect();
    const sx = (clientX - rect.left + this.scroll.scrollLeft) / this.scale;
    const sy = (clientY - rect.top  + this.scroll.scrollTop ) / this.scale;
    this.scale = newScale;
    this.container.style.transform = `scale(${this.scale})`;
    if (keepCenter){
      const nx = sx * this.scale - (clientX - rect.left);
      const ny = sy * this.scale - (clientY - rect.top);
      this.scroll.scrollLeft = nx; this.scroll.scrollTop = ny;
    }
  }
  _onWheel(e){ if (this.suspended) return; if (!(e.ctrlKey||e.metaKey)) return; e.preventDefault(); this.setScale(this.scale*(e.deltaY<0?1.1:0.9), e.clientX, e.clientY, true); }
  _pd(e){ if (this.suspended) return; this._pts.set(e.pointerId,e); if (this._pts.size===2){ this._pinching=true; const [a,b]=[...this._pts.values()]; this._lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); this._cx=(a.clientX+b.clientX)/2; this._cy=(a.clientY+b.clientY)/2; } }
  _pm(e){ if (this.suspended) return; if (!this._pts.has(e.pointerId)) return; this._pts.set(e.pointerId,e); if (this._pinching && this._pts.size===2){ const [a,b]=[...this._pts.values()]; const dist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); if(this._lastDist){ this.setScale(this.scale*(dist/this._lastDist), this._cx, this._cy, true); } this._lastDist=dist; } }
  _pu(e){ this._pts.delete(e.pointerId); if (this._pts.size<2){ this._pinching=false; this._lastDist=0; } }
}
const zoom = new Zoom(refs.container, refs.scroll);

// center pages horizontally at current zoom
function centerHorizontally() {
  const firstW = CURRENT_PDF.vpCSSByPage[0]?.width ||
    parseFloat(CURRENT_PDF.wraps[0]?.querySelector('canvas')?.style.width||'0');
  if (!firstW) return;
  const contentW = firstW * zoom.scale;
  refs.scroll.scrollLeft = Math.max(0, (contentW - refs.scroll.clientWidth) / 2);
}
on(window,'resize', centerHorizontally);

// === Annotations (double‑tap/click text; stamp; signatures) ===
class Annotations {
  constructor(container){
    this.container = container;
    this.mode = null;
    this.history = []; this.redoStack = [];
    this.overlays = []; this.selected = null;
    this.textStyle = { size:16, color:'#000', bold:false, italic:false, family:'Arial, sans-serif' };
    this.drag = { el:null, overlay:null, dx:0, dy:0 };
    this.resize = { el:null, overlay:null, startW:0, startH:0, sx:0, sy:0 };
    on(document,'pointermove',(e)=>this._onMove(e),{passive:false});
    on(document,'pointerup',  (e)=>this._onUp(e));
  }
  setMode(m){ this.mode = m; this._select(null); }
  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove());
    this.overlays = [];
    wrapInfos.forEach(({wrap})=>{
      const ov = document.createElement('div'); ov.className='overlay';
      wrap.appendChild(ov);

      on(ov,'pointerdown', (e)=>{ if (e.target===ov) this._select(null); }, {passive:true});

      on(ov,'dblclick', (e)=>{
        if (this.mode !== 'text' || e.target !== ov) return;
        const {x,y} = this._pos(ov, e);
        this._addText(ov, x, y, true);
        Session.bumpDirty?.();
      });

      if (isTouch){
        let lastTap = 0, lastX=0, lastY=0;
        on(ov,'pointerdown',(e)=>{
          if (this.mode !== 'text' || e.pointerType !== 'touch') return;
          const now = performance.now();
          const {x,y} = this._pos(ov, e);
          const dt = now - lastTap, dx=Math.abs(x-lastX), dy=Math.abs(y-lastY);
          if (dt < 300 && dx < 24 && dy < 24){
            this._addText(ov, x, y, true);
            Session.bumpDirty?.();
            lastTap = 0;
          } else { lastTap = now; lastX=x; lastY=y; }
        }, {passive:true});
      }

      on(ov,'pointerdown', (e)=>{
        if (this.mode !== 'stamp' || e.target !== ov) return;
        const {x,y} = this._pos(ov, e);
        this._addStamp(ov, x, y);
        Session.bumpDirty?.();
      }, {passive:true});

      this.overlays.push(ov);
    });
  }

  _pos(overlay,e){ const r=overlay.getBoundingClientRect(); return { x:(e.clientX-r.left)/zoom.scale, y:(e.clientY-r.top)/zoom.scale }; }
  _elSizeUnscaled(el){ return { w: el.offsetWidth, h: el.offsetHeight }; }

  _addText(overlay,x,y,focus){
    const el = document.createElement('div');
    el.className='anno text'; el.contentEditable='true';
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    const st=this.textStyle;
    el.style.color = st.color; el.style.fontSize = `${Math.max(16,st.size)}px`;
    el.style.fontWeight = st.bold?'700':'400'; el.style.fontStyle = st.italic?'italic':'normal';
    el.style.fontFamily = st.family;
    overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:true});
    if (focus) this._focus(el);
    this._recordAdd(overlay, el);
  }
  _addStamp(overlay,x,y){
    const el = document.createElement('div');
    el.className='anno stamp'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    el.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M4 12l4 4 12-12"/></svg>`;
    overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:false});
    this._recordAdd(overlay, el);
  }
  _addSignature(overlay,x,y,dataURL,widthHint){
    const el = document.createElement('div');
    el.className='anno sign'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const img = new Image(); img.draggable=false; img.src=dataURL; img.style.display='block';
    el.appendChild(img); overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:true});
    img.onload = ()=>{
      const maxW = widthHint || Math.min(overlay.clientWidth*0.6, img.naturalWidth);
      const r = maxW / img.naturalWidth; img.width = maxW; img.height = img.naturalHeight * r;
    };
    this._recordAdd(overlay, el);
  }

  _wireAnno(el, overlay, {resizable}){
    const startDrag = (e)=>{
      if (el.classList.contains('text') && document.activeElement === el) { this._select(el); return; }
      const {x,y} = this._pos(overlay,e);
      const left = parseFloat(el.style.left)||0;
      const top  = parseFloat(el.style.top)||0;
      this.drag = { el, overlay, dx:x-left, dy:y-top };
      $('#pdf-scroll').style.touchAction = 'none';
      zoom.suspend(true);
      el.setPointerCapture?.(e.pointerId);
      this._select(el);
      e.preventDefault();
    };
    on(el,  'pointerdown', startDrag, {passive:false});
    const innerImg = el.querySelector('img'); if (innerImg) on(innerImg,'pointerdown', startDrag, {passive:false});

    if (el.classList.contains('text')) {
      on(el, 'dblclick', ()=>{ this._focus(el); this._select(el); });
      on(el, 'input',   ()=> Session.bumpDirty?.());
    }

    if (resizable){
      const h = document.createElement('div'); h.className='handle br'; el.appendChild(h);
      on(h, 'pointerdown', (e)=>{
        e.stopPropagation();
        const { w, h:hh } = this._elSizeUnscaled(el);
        this.resize = { el, overlay, startW:w, startH:hh, sx:e.clientX, sy:e.clientY };
        $('#pdf-scroll').style.touchAction = 'none';
        zoom.suspend(true);
        h.setPointerCapture?.(e.pointerId);
      }, {passive:false});
    }
  }
  _onMove(e){
    if (this.drag.el){
      const {x,y} = this._pos(this.drag.overlay,e);
      let nx = x - this.drag.dx, ny = y - this.drag.dy;
      const overlayW = this.drag.overlay.clientWidth, overlayH = this.drag.overlay.clientHeight;
      const { w:elW, h:elH } = this._elSizeUnscaled(this.drag.el);
      nx = Math.max(0, Math.min(nx, overlayW - elW));
      ny = Math.max(0, Math.min(ny, overlayH - elH));
      this.drag.el.style.left = `${nx}px`; this.drag.el.style.top  = `${ny}px`;
      e.preventDefault(); return;
    }
    if (this.resize.el){
      const dx = (e.clientX - this.resize.sx) / zoom.scale;
      const dy = (e.clientY - this.resize.sy) / zoom.scale;
      const w = Math.max(24, this.resize.startW + dx);
      const h = Math.max(16, this.resize.startH + dy);
      const el = this.resize.el;
      if (el.classList.contains('text')){
        const cur = parseFloat(getComputedStyle(el).fontSize)||16;
        const scale = h / this.resize.startH;
        el.style.fontSize = `${Math.max(16, cur*scale)}px`;
      } else {
        const img = el.querySelector('img'); if (img){ img.style.width = w+'px'; img.style.height='auto'; }
      }
      e.preventDefault();
    }
  }
  _onUp(e){
    const changed = this.drag.el || this.resize.el;
    if (this.drag.el){ try{ this.drag.el.releasePointerCapture?.(e.pointerId) }catch{}; this.drag={el:null,overlay:null,dx:0,dy:0}; }
    if (this.resize.el){ try{ this.resize.el.releasePointerCapture?.(e.pointerId) }catch{}; this.resize={el:null,overlay:null,startW:0,startH:0,sx:0,sy:0}; }
    $('#pdf-scroll').style.touchAction = 'pan-y';
    zoom.suspend(false);
    if (changed) Session.bumpDirty?.();
  }

  _focus(el){
    el.focus();
    const sel = getSelection(); const range = document.createRange();
    range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
  }
  _select(el){ this.container.querySelectorAll('.anno').forEach(n=>n.classList.remove('selected')); this.selected=el; if (el) el.classList.add('selected'); }

  undo(){ const last=this.history.pop(); if (!last) return; if (last.el?.parentNode){ last.el.parentNode.removeChild(last.el); if (this.selected===last.el) this._select(null); this.redoStack.push(last);} Session.bumpDirty?.(); }
  redo(){ const next=this.redoStack.pop(); if (!next) return; if (next.el){ next.overlay.appendChild(next.el); this.history.push(next);} Session.bumpDirty?.(); }
  _recordAdd(overlay, el){ this.history.push({ type:'add', overlay, el }); this.redoStack.length=0; }

  serialize(){
    return this.overlays.map((ov)=> {
      const annos = [];
      ov.querySelectorAll('.anno').forEach(el=>{
        const item = {
          kind: el.classList.contains('text') ? 'text' :
                 el.classList.contains('stamp') ? 'stamp' : 'sign',
          x: el.offsetLeft, y: el.offsetTop,
          w: el.offsetWidth, h: el.offsetHeight
        };
        if (item.kind==='text'){
          const cs = getComputedStyle(el);
          item.text  = el.textContent || '';
          item.style = {
            size: parseFloat(cs.fontSize)||16,
            color: cs.color,
            bold: (parseInt(cs.fontWeight,10) || 400) >= 600,
            italic: cs.fontStyle === 'italic',
            family: cs.fontFamily
          };
        } else if (item.kind==='sign'){
          const img = el.querySelector('img'); item.dataURL = img?.src || '';
        }
        annos.push(item);
      });
      return { annos };
    });
  }
  async deserialize(pages){
    if (!pages) return;
    this.overlays.forEach(ov => ov.innerHTML = '');
    pages.forEach((pg, i)=>{
      const ov = this.overlays[i]; if (!ov) return;
      pg.annos?.forEach(a=>{
        if (a.kind==='text'){
          const el = document.createElement('div');
          el.className='anno text'; el.contentEditable='true';
          el.style.left=`${a.x}px`; el.style.top=`${a.y}px`;
          const st=a.style||{};
          el.style.fontSize = `${Math.max(16, st.size||16)}px`;
          el.style.color    = st.color || '#000';
          el.style.fontWeight = st.bold ? '700':'400';
          el.style.fontStyle  = st.italic? 'italic':'normal';
          el.style.fontFamily = st.family || 'Arial, sans-serif';
          el.textContent = a.text || '';
          ov.appendChild(el);
          this._wireAnno(el, ov, {resizable:true});
        } else if (a.kind==='stamp'){
          const el = document.createElement('div');
          el.className='anno stamp'; el.style.left=`${a.x}px`; el.style.top=`${a.y}px`;
          el.innerHTML = `<svg viewBox="0 0 24 24" width="${Math.max(16,a.w)}" height="${Math.max(16,a.h)}" style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M4 12l4 4 12-12"/></svg>`;
          ov.appendChild(el);
          this._wireAnno(el, ov, {resizable:false});
        } else if (a.kind==='sign'){
          const el = document.createElement('div'); el.className='anno sign';
          el.style.left=`${a.x}px`; el.style.top=`${a.y}px`;
          const img = new Image(); img.draggable=false; img.src=a.dataURL||''; img.style.display='block';
          img.style.width = `${Math.max(24,a.w)}px`; img.style.height='auto';
          el.appendChild(img); ov.appendChild(el);
          this._wireAnno(el, ov, {resizable:true});
        }
      });
    });
  }
}
const ann = new Annotations(refs.container);

// === Signature Pad (white UI; transparent bitmap) ===
class SigPad {
  constructor(canvas, modal){
    this.canvas = canvas; this.modal = modal; this.ctx = canvas.getContext('2d');
    this.clear();
    this.drawing=false;
    const pos = (ev)=>{ const r=canvas.getBoundingClientRect(); const dpr=Math.max(1,devicePixelRatio||1); return { x:(ev.clientX-r.left)*dpr, y:(ev.clientY-r.top)*dpr }; };
    on(canvas,'pointerdown',(e)=>{ canvas.setPointerCapture?.(e.pointerId); this.drawing=true; const p=pos(e); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointermove',(e)=>{ if(!this.drawing) return; const p=pos(e); this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(canvas,'pointerup',  ()=>{ this.drawing=false; });
  }
  open(){ this.modal.classList.add('show'); }
  close(){ this.modal.classList.remove('show'); }
  clear(){
    const dpr = Math.max(1, devicePixelRatio||1);
    this.canvas.width = 500*dpr; this.canvas.height=200*dpr;
    this.canvas.style.width='500px'; this.canvas.style.height='200px';
    const c=this.ctx; c.setTransform(1,0,0,1,0,0);
    c.clearRect(0,0,this.canvas.width,this.canvas.height); // transparent bitmap
    c.lineWidth=2.5*dpr; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round';
  }
  dataURL(){ return this.canvas.toDataURL('image/png'); } // preserves alpha
}
const sig = new SigPad(refs.sigPad, refs.sigModal);

// === Signature controller ===
class SigController {
  constructor(sig, ann){ this.sig=sig; this.ann=ann; }
  open(){ this.sig.open(); }
  close(){ this.sig.close(); }
  use(){
    let target = ann.overlays[0] || null;
    if (ann.overlays.length){
      const midX = refs.scroll.scrollLeft + refs.scroll.clientWidth/2;
      const midY = refs.scroll.scrollTop  + refs.scroll.clientHeight/2;
      target = ann.overlays.find(ov => {
        const r = ov.getBoundingClientRect();
        const c = refs.container.getBoundingClientRect();
        const left = r.left - c.left + refs.scroll.scrollLeft;
        const top  = r.top  - c.top  + refs.scroll.scrollTop;
        return midX>=left && midX<=left+r.width && midY>=top && midY<=top+r.height;
      }) || target;
    }
    if (!target){ this.close(); return; }
    const rect = target.getBoundingClientRect();
    const x = (rect.width / zoom.scale) * 0.5;
    const y = (rect.height/ zoom.scale) * 0.5;
    this.ann._addSignature(target, x, y, this.sig.dataURL(), (rect.width/zoom.scale)*0.5);
    Session.bumpDirty?.();
    this.close();
  }
}
const sigCtl = new SigController(sig, ann);
if (refs.sigModal) refs.sigModal.classList.remove('show');

// === PDF rendering @ 1:1 CSS ===
async function renderPdfFromFile(file, container, scale=1){
  const bytes = new Uint8Array(await file.arrayBuffer());
  CURRENT_PDF.bytes = bytes; CURRENT_PDF.filename = file.name || 'document.pdf';
  return renderPdfFromData(bytes, container, scale);
}
async function renderPdfFromData(bytes, container, scale=1){
  container.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ data: bytes }).promise; } catch (err) { throw err; }
  const ratio = Math.max(1, Math.min(2, devicePixelRatio||1));

  for (let i=1;i<=pdf.numPages;i++){
    try {
      const page = await pdf.getPage(i);
      const vpCSS = page.getViewport({ scale });                 // CSS @ 1:1
      const vpDev = page.getViewport({ scale: scale * ratio });  // device pixels

      const wrap = document.createElement('div'); wrap.className='page-wrap';
      const canvas = document.createElement('canvas'); canvas.className='pdfpage';
      canvas.width  = Math.floor(vpDev.width); canvas.height = Math.floor(vpDev.height);
      canvas.style.width = vpCSS.width+'px'; canvas.style.height = vpCSS.height+'px';

      wrap.appendChild(canvas); container.appendChild(wrap);
      const ctx = canvas.getContext('2d', { alpha:false, desynchronized:true });
      await page.render({ canvasContext: ctx, viewport: vpDev, intent: 'display' }).promise;

      CURRENT_PDF.wraps.push(wrap);
      CURRENT_PDF.vpCSSByPage.push({ width: vpCSS.width, height: vpCSS.height });
    } catch (pageErr) { console.warn('Page render warning:', pageErr); }
  }

  requestAnimationFrame(centerHorizontally);
  setTimeout(centerHorizontally, 120);

  return CURRENT_PDF.wraps.map((wrap,i)=>({ wrap, vpCSS: CURRENT_PDF.vpCSSByPage[i] }));
}

// === Save (uses local lib/pdf-lib.min.js to avoid CDN hiccups) ===
async function saveFlattened(){
  if (!CURRENT_PDF.bytes){ toast('Open a PDF first', 'err'); return; }
  let PDFDocument, rgb, StandardFonts;
  try {
    ({ PDFDocument, rgb, StandardFonts } = await import('../pdf-lib.min.js'));
  } catch (e) { console.error(e); toast('Could not load save engine', 'err'); return; }

  try {
    const pdf = await PDFDocument.load(CURRENT_PDF.bytes);
    const helv  = await pdf.embedFont(StandardFonts.Helvetica);
    const helvB = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages = pdf.getPages();
    const ops = [];

    CURRENT_PDF.wraps.forEach((wrap, idx)=>{
      const overlay = wrap.querySelector('.overlay'); if (!overlay) return;
      const page = pages[idx];
      const pageW = page.getWidth(), pageH = page.getHeight();
      const vp = CURRENT_PDF.vpCSSByPage[idx]; const cssW = vp.width, cssH = vp.height;
      const fx = pageW / cssW, fy = pageH / cssH;

      overlay.querySelectorAll('.anno').forEach(el=>{
        const left = el.offsetLeft, top = el.offsetTop;
        const w = el.offsetWidth,  h  = el.offsetHeight;
        const x = left * fx;
        const y = pageH - (top + h) * fy;

        if (el.classList.contains('text')){
          const cs = getComputedStyle(el);
          const size = (parseFloat(cs.fontSize)||16) * fx;
          const [rr,gg,bb] = (cs.color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
          const bold = (parseInt(cs.fontWeight,10)||400) >= 600;
          const font = bold ? helvB : helv;
          page.drawText(el.textContent||'', { x, y, size, font, color: rgb(rr,gg,bb) });
        } else if (el.classList.contains('stamp')){
          const stroke = rgb(0,0,0);
          const x1=x, y1=y + h*fy*0.45, x2=x + w*fx*0.35, y2=y + h*fy*0.15, x3=x + w*fx, y3=y + h*fy*0.85;
          page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:2*fx, color:stroke });
          page.drawLine({ start:{x:x2,y:y2}, end:{x:x3,y:y3}, thickness:2*fx, color:stroke });
        } else if (el.classList.contains('sign')){
          const img = el.querySelector('img'); if (!img) return;
          const p = new Promise((resolve)=>{
            const b64 = (img.src||'').split(',')[1]||'';
            const bin = atob(b64); const bytes = new Uint8Array(bin.length);
            for (let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i);
            pdf.embedPng(bytes).then(png=> { page.drawImage(png, { x, y, width:w*fx, height:h*fy }); resolve(); });
          });
          ops.push(p);
        }
      });
    });

    if (ops.length) await Promise.all(ops);
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
      }catch(e){ /* fall back */ }
    }
    const blob = new Blob([out], { type:'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = defaultName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(a.href), 1200);
    toast('Downloaded ✔️');
  } catch (e) {
    console.error(e);
    toast('Could not save PDF', 'err');
  }
}

// === Settings panel (robust) ===
const Settings = (() => {
  let panel, sizeInp, colorInp, boldInp, italicInp, familySel;
  const state = { size:16, color:'#000000', bold:false, italic:false, family:'Arial, sans-serif' };

  function build(){
    panel = document.createElement('div');
    Object.assign(panel.style, {
      position:'fixed', right:'12px', bottom:'calc(88px + env(safe-area-inset-bottom,0px))', zIndex:'60',
      background:'rgba(20,24,32,.94)', border:'1px solid rgba(255,255,255,.14)', borderRadius:'12px',
      padding:'10px', minWidth:'240px', display:'none', color:'#e9eef5', font:'13px system-ui, sans-serif'
    });
    panel.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <label style="display:flex;gap:6px;align-items:center">Size
          <input id="ts-size" type="range" min="16" max="48" step="1" value="${state.size}" />
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

    sizeInp   = panel.querySelector('#ts-size');
    colorInp  = panel.querySelector('#ts-color');
    boldInp   = panel.querySelector('#ts-bold');
    italicInp = panel.querySelector('#ts-italic');
    familySel = panel.querySelector('#ts-family');

    const apply = (part)=>{
      Object.assign(state, part);
      ann.textStyle = { ...ann.textStyle, ...state };
      const el = ann.selected;
      if (el && el.classList.contains('text')) {
        el.style.fontSize  = `${Math.max(16, state.size)}px`;
        el.style.color     = state.color;
        el.style.fontWeight= state.bold ? '700':'400';
        el.style.fontStyle = state.italic? 'italic':'normal';
        el.style.fontFamily= state.family;
        Session.bumpDirty?.();
      }
    };

    sizeInp.addEventListener('input', ()=>{ panel.querySelector('#ts-size-val').textContent = sizeInp.value; apply({size:+sizeInp.value}); }, {passive:true});
    colorInp.addEventListener('input', ()=> apply({color:colorInp.value}), {passive:true});
    boldInp.addEventListener('change', ()=> apply({bold:boldInp.checked}));
    italicInp.addEventListener('change', ()=> apply({italic:italicInp.checked}));
    familySel.addEventListener('change', ()=> apply({family:familySel.value}));
  }
  function toggle(){ if (!panel) return; panel.style.display = panel.style.display==='none' ? 'block' : 'none'; }
  function syncFromElement(el){
    if (!panel) return;
    const cs = getComputedStyle(el);
    const rgbToHex = (rgb)=>{ const m = rgb.match(/\d+/g); if (!m) return '#000000'; const [r,g,b] = m.map(n=>(+n)|0); return '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join(''); };
    Object.assign(state, {
      size   : Math.max(16, parseFloat(cs.fontSize)||16),
      color  : rgbToHex(cs.color)||'#000000',
      bold   : (parseInt(cs.fontWeight,10)||400) >= 600,
      italic : cs.fontStyle === 'italic',
      family : cs.fontFamily
    });
    panel.querySelector('#ts-size').value = String(state.size);
    panel.querySelector('#ts-size-val').textContent = state.size;
    panel.querySelector('#ts-color').value = state.color;
    panel.querySelector('#ts-bold').checked = state.bold;
    panel.querySelector('#ts-italic').checked = state.italic;
    panel.querySelector('#ts-family').value = state.family;
    ann.textStyle = { ...state };
  }
  return { build, toggle, syncFromElement };
})();
Settings.build();

// === Session restore (autosave) ===
const Session = (() => {
  const KEY = 'turbosign.session.v1';
  let dirty = false; let timer = null;
  function saveSnapshot(){
    if (!CURRENT_PDF.filename || !ann.overlays.length) return;
    const snapshot = { ts: Date.now(), filename: CURRENT_PDF.filename, pages: ann.serialize() };
    try { localStorage.setItem(KEY, JSON.stringify(snapshot)); } catch {}
  }
  function bumpDirty(){ dirty = true; clearTimeout(timer); timer = setTimeout(()=>{ if (dirty){ saveSnapshot(); dirty=false; } }, 600); }
  function loadSnapshot(){ try{ const raw = localStorage.getItem(KEY); return raw?JSON.parse(raw):null; }catch{ return null; } }
  function clear(){ try{ localStorage.removeItem(KEY); }catch{} }
  return { bumpDirty, loadSnapshot, clear };
})();

// === UI wiring ===
function wireUI(){
  on(refs.openBtn, 'click', ()=> refs.fileInput?.click());

  on(refs.fileInput, 'change', async (e)=>{
    const file = e.target.files?.[0]; if (!file) return;

    let infos;
    try { infos = await renderPdfFromFile(file, refs.container, 1); }
    catch (renderErr) { console.error('PDF open failed:', renderErr); toast('Could not open PDF', 'err'); return; }

    try { ann.attachOverlays(infos); } catch (attachErr) { console.warn('Overlay attach issue:', attachErr); }
    toast('PDF loaded ✔️');
    centerHorizontally();

    try {
      const snap = Session.loadSnapshot?.();
      if (snap && snap.filename === (CURRENT_PDF.filename||file.name)){
        refs.restoreText.textContent = `Restore work from last session on “${snap.filename}”?`;
        refs.restoreBanner.style.display = 'flex';
        once(refs.restoreYes,'click', async ()=>{
          refs.restoreBanner.style.display='none';
          try { await ann.deserialize(snap.pages); toast('Session restored ✔️'); }
          catch (dErr) { console.warn('Restore failed:', dErr); toast('Could not restore previous session', 'err'); }
        });
        once(refs.restoreNo,'click', ()=>{ refs.restoreBanner.style.display='none'; Session.clear?.(); toast('Discarded previous session'); });
      }
    } catch (restErr) { console.warn('Restore prompt issue:', restErr); }
  });

  on(refs.textBtn,  'click', ()=>{ ann.setMode(ann.mode==='text'?null:'text');  toast(ann.mode ? (isTouch?'Text: double‑tap':'Text: double‑click') : 'Tool off'); });
  on(refs.stampBtn, 'click', ()=>{ ann.setMode(ann.mode==='stamp'?null:'stamp'); toast(ann.mode?'Stamp: tap/click':'Tool off'); });
  on(refs.signBtn,  'click', ()=>{ ann.setMode(null); sigCtl.open(); });

  on(refs.undoBtn,  'click', ()=> ann.undo());
  on(refs.redoBtn,  'click', ()=> ann.redo());
  on(refs.helpBtn,  'click', ()=> toast('📂 Open a PDF. Text: double‑tap/click; Stamp: tap; Signature: draw → Use. Drag/resize; Save to flatten.', 'ok', 3800));
  on(refs.settingsBtn, 'click', ()=> { Settings.toggle(); if (ann.selected && ann.selected.classList.contains('text')) Settings.syncFromElement(ann.selected); });
  on(refs.saveBtn,     'click', saveFlattened);

  on(refs.sigUse,   'click', (e)=>{ e.stopPropagation(); sigCtl.use();   });
  on(refs.sigClear, 'click', (e)=>{ e.stopPropagation(); sig.clear();    });
  on(refs.sigCancel,'click', (e)=>{ e.stopPropagation(); sigCtl.close(); });
}
wireUI();

// Startup: generic restore hint
(function(){
  const snap = Session.loadSnapshot();
  if (!snap) return;
  refs.restoreText.textContent = `Previous session found for “${snap.filename}”. Open that PDF to restore?`;
  refs.restoreBanner.style.display = 'flex';
  once(refs.restoreYes,'click', ()=>{ refs.restoreBanner.style.display='none'; toast('Open the same PDF file to restore your work.'); });
  once(refs.restoreNo,'click',  ()=>{ refs.restoreBanner.style.display='none'; Session.clear(); toast('Discarded previous session'); });
})();

// Suppress benign promise rejections
window.addEventListener('unhandledrejection', (ev) => {
  const msg = String(ev.reason?.message || ev.reason || '');
  if (msg.includes('Rendering cancelled') || msg.includes('AbortError')) { ev.preventDefault(); }
});
