// lib/app/app.mjs
// === PDF.js ESM + worker ===
import * as pdfjsLib from '../../build/pdf.mjs';
try {
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
    new URL('../../build/pdf.worker.mjs', import.meta.url),
    { type: 'module' }
  );
} catch {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../build/pdf.worker.mjs', import.meta.url).toString();
}

// === helpers ===
const $  = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const once = (el, ev, cb, opts) => el && el.addEventListener(ev, function h(e){ el.removeEventListener(ev, h, opts); cb(e); }, opts);
const toast = (msg, kind='ok', t=2200) => {
  const n = $('#toast'); if (!n) return;
  n.textContent = msg; n.className = ''; n.classList.add('show', kind);
  clearTimeout(n._t); n._t = setTimeout(()=>{ n.className=''; }, t);
};
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;

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

// === Zoom: pinch + Ctrl/⌘+wheel (NO double‑tap zoom) ===
class Zoom {
  constructor(container, scroll){
    this.container = container;
    this.scroll = scroll;
    this.scale = 1; this.min = 0.6; this.max = 3;
    this._pts = new Map(); this._pinching=false; this._lastDist=0; this._cx=0; this._cy=0;
    container.style.transformOrigin = '0 0';
    on(scroll,'wheel',(e)=>this._onWheel(e),{passive:false});
    on(scroll,'pointerdown',(e)=>this._pd(e));
    on(scroll,'pointermove',(e)=>this._pm(e));
    on(scroll,'pointerup',  (e)=>this._pu(e));
    on(scroll,'pointercancel',(e)=>this._pu(e));
  }

  fitToWidth(vpCssWidth){
    const stageW = this.scroll.clientWidth - 16;            // small gutter
    const base = Math.max(1, vpCssWidth || 800);            // intrinsic CSS width
    const target = Math.max(this.min, Math.min(this.max, stageW / base));

    const cx = this.scroll.clientWidth / 2, cy = this.scroll.clientHeight / 2;
    this.setScale(target, cx, cy, true);

    const contentW = base * this.scale;
    this.scroll.scrollLeft = Math.max(0, (contentW - this.scroll.clientWidth) / 2);
  }

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
  _onWheel(e){ if (!(e.ctrlKey||e.metaKey)) return; e.preventDefault(); this.setScale(this.scale*(e.deltaY<0?1.1:0.9), e.clientX, e.clientY, true); }
  _pd(e){ this._pts.set(e.pointerId,e); if (this._pts.size===2){ this._pinching=true; const [a,b]=[...this._pts.values()]; this._lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); this._cx=(a.clientX+b.clientX)/2; this._cy=(a.clientY+b.clientY)/2; } }
  _pm(e){ if (!this._pts.has(e.pointerId)) return; this._pts.set(e.pointerId,e); if (this._pinching && this._pts.size===2){ const [a,b]=[...this._pts.values()]; const dist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); if(this._lastDist){ this.setScale(this.scale*(dist/this._lastDist), this._cx, this._cy, true); } this._lastDist=dist; } }
  _pu(e){ this._pts.delete(e.pointerId); if (this._pts.size<2){ this._pinching=false; this._lastDist=0; } }
}
const zoom = new Zoom(refs.container, refs.scroll);

// === Annotations (double‑tap/click to add text; drag; settings to resize text) ===
class Annotations {
  constructor(container){
    this.container = container;
    this.mode = null; // 'text' | 'stamp' | 'sign' | null
    this.history = []; this.redoStack = [];
    this.overlays = []; this.selected = null;
    this.textStyle = { size:16, color:'#000', bold:false, italic:false, family:'Arial, sans-serif' };
    this.drag = { el:null, overlay:null, dx:0, dy:0 };
    on(document,'pointermove',(e)=>this._onMove(e),{passive:false});
    on(document,'pointerup',  (e)=>this._onUp(e));
  }
  setMode(m){ this.mode = m; this._select(null); }
  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove());
    this.overlays = [];
    wrapInfos.forEach((info)=>{
      const ov = document.createElement('div'); ov.className='overlay';
      info.wrap.appendChild(ov);

      // clear selection when tapping empty space
      on(ov,'pointerdown', (e)=>{ if (e.target===ov) this._select(null); }, {passive:true});

      // add text: desktop dblclick
      on(ov,'dblclick', (e)=>{
        if (this.mode !== 'text' || e.target !== ov) return;
        const {x,y} = this._pos(ov, e);
        this._addText(ov, x, y, true); Session.bumpDirty();
      });

      // add text: touch double‑tap
      if (isTouch){
        let lastTap = 0, lastX=0, lastY=0;
        on(ov,'pointerdown',(e)=>{
          if (this.mode !== 'text' || e.pointerType !== 'touch') return;
          const now = performance.now(); const {x,y} = this._pos(ov, e);
          const dt = now-lastTap, dx=Math.abs(x-lastX), dy=Math.abs(y-lastY);
          if (dt < 300 && dx < 24 && dy < 24){
            this._addText(ov, x, y, true); Session.bumpDirty(); lastTap=0;
          } else { lastTap=now; lastX=x; lastY=y; }
        }, {passive:true});
      }

      // stamp: single tap/click
      on(ov,'pointerdown', (e)=>{
        if (this.mode !== 'stamp') return;
        const {x,y} = this._pos(ov, e);
        this._addStamp(ov, x, y); Session.bumpDirty();
      }, {passive:true});

      this.overlays.push(ov);
    });
  }

  // create
  _addText(overlay,x,y,focus){
    const el = document.createElement('div');
    el.className='anno text'; el.contentEditable='true';
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    el.style.color = this.textStyle.color;
    el.style.fontSize = `${Math.max(16,this.textStyle.size)}px`;
    el.style.fontWeight = this.textStyle.bold ? '700':'400';
    el.style.fontStyle  = this.textStyle.italic ? 'italic':'normal';
    el.style.fontFamily = this.textStyle.family;
    overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:false}); // <- no handle
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
    el.className='anno sign';
    el.style.left=`${x}px`; el.style.top=`${y}px`;
    const img = new Image(); img.draggable=false; img.src=dataURL; img.style.display='block';
    el.appendChild(img); overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:true}); // signatures stay resizable
    img.onload = ()=>{
      const maxW = widthHint || Math.min(overlay.clientWidth*0.6, img.naturalWidth);
      const r = maxW / img.naturalWidth;
      img.width = maxW; img.height = img.naturalHeight * r;
    };
    this._recordAdd(overlay, el);
  }

  // selection/drag
  _wireAnno(el, overlay, {resizable}){
    // drag to move
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
    }, {passive:false});

    // dblclick on text to edit
    if (el.classList.contains('text')) {
      on(el, 'dblclick', ()=>{ this._focus(el); this._select(el); });
      on(el, 'input', ()=> Session.bumpDirty());
    }

    if (resizable){
      const h = document.createElement('div'); h.className='handle br'; el.appendChild(h);
      on(h, 'pointerdown', (e)=>{
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        this.resize = { el, overlay, startW:r.width, startH:r.height, sx:e.clientX, sy:e.clientY };
        $('#pdf-scroll').style.touchAction = 'none';
        h.setPointerCapture?.(e.pointerId);
      }, {passive:false});

      on(document,'pointermove',(e)=>{
        if (!this.resize || this.resize.el!==el) return;
        const dx = (e.clientX - this.resize.sx);
        const w = Math.max(24, this.resize.startW + dx);
        const img = el.querySelector('img'); if (img){ img.style.width = w+'px'; img.style.height='auto'; }
      }, {passive:false});
      on(document,'pointerup', ()=>{
        if (this.resize && this.resize.el===el){ this.resize=null; $('#pdf-scroll').style.touchAction='pan-y'; Session.bumpDirty(); }
      });
    }
  }
  _onMove(e){
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
  }
  _onUp(e){
    if (this.drag.el){ try{ this.drag.el.releasePointerCapture?.(e.pointerId) }catch{}; this.drag={el:null,overlay:null,dx:0,dy:0}; }
    $('#pdf-scroll').style.touchAction = 'pan-y';
    Session.bumpDirty();
  }

  _focus(el){
    el.focus();
    const sel = getSelection(); const range = document.createRange();
    range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
  }
  _select(el){ this.container.querySelectorAll('.anno').forEach(n=>n.classList.remove('selected')); this.selected=el; if (el) el.classList.add('selected'); }
  _pos(overlay,e){ const r=overlay.getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top }; }

  // history (light)
  undo(){ const last=this.history.pop(); if (!last) return; if (last.el?.parentNode){ last.el.parentNode.removeChild(last.el); if (this.selected===last.el) this._select(null); this.redoStack.push(last);} Session.bumpDirty(); }
  redo(){ const next=this.redoStack.pop(); if (!next) return; if (next.el){ next.overlay.appendChild(next.el); this.history.push(next);} Session.bumpDirty(); }
  _recordAdd(overlay, el){ this.history.push({ type:'add', overlay, el }); this.redoStack.length=0; }

  // minimal serialize/deserialize
  serialize(){
    return this.overlays.map((ov)=> {
      const annos = [];
      ov.querySelectorAll('.anno').forEach(el=>{
        const r = el.getBoundingClientRect();
        const or = ov.getBoundingClientRect();
        const item = {
          kind: el.classList.contains('text') ? 'text' :
                el.classList.contains('stamp') ? 'stamp' : 'sign',
          x: r.left - or.left, y: r.top - or.top,
          w: r.width, h: r.height
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
          this._wireAnno(el, ov, {resizable:false}); // <- no handle on restore
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

// === Signature Pad ===
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
    c.fillStyle='#fff'; c.fillRect(0,0,this.canvas.width,this.canvas.height);
    c.lineWidth=2.5*dpr; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round';
  }
  dataURL(){ return this.canvas.toDataURL('image/png'); }
}
const sig = new SigPad(refs.sigPad, refs.sigModal);

// === Signature controller ===
class SigController {
  constructor(sig, ann){ this.sig=sig; this.ann=ann; }
  open(){ this.sig.open(); }
  close(){ this.sig.close(); }
  use(){
    // pick the overlay with largest visible area
    let best = null, bestArea = 0;
    for (const ov of ann.overlays){
      const r = ov.getBoundingClientRect();
      const vx = Math.max(0, Math.min(window.innerWidth,  r.right)  - Math.max(0, r.left));
      const vy = Math.max(0, Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top));
      const area = vx * vy;
      if (area > bestArea){ bestArea = area; best = ov; }
    }
    const target = best || ann.overlays[0]; if (!target){ this.close(); return; }
    const rect = target.getBoundingClientRect();
    const x = rect.width * 0.5, y = rect.height * 0.5;
    this.ann._addSignature(target, x, y, this.sig.dataURL(), rect.width*0.5);
    Session.bumpDirty();
    this.close();
  }
}
const sigCtl = new SigController(sig, ann);
if (refs.sigModal) refs.sigModal.classList.remove('show'); // ensure hidden on boot

// === PDF rendering (robust) ===
async function renderPdfFromFile(file, container, scale=1.5){
  const bytes = new Uint8Array(await file.arrayBuffer());
  CURRENT_PDF.bytes = bytes; CURRENT_PDF.filename = file.name || 'document.pdf';
  return renderPdfFromData(bytes, container, scale);
}

async function renderPdfFromData(bytes, container, scale=1.5){
  container.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) { throw err; }

  const ratio = Math.max(1, Math.min(2, devicePixelRatio||1));

  for (let i=1;i<=pdf.numPages;i++){
    try {
      const page = await pdf.getPage(i);
      const vpCSS = page.getViewport({ scale });
      const vpDev = page.getViewport({ scale: scale * ratio });

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

  // fit & center (double pass for iOS)
  const firstWidth = CURRENT_PDF.vpCSSByPage[0]?.width || parseFloat(
    CURRENT_PDF.wraps[0]?.querySelector('canvas')?.style.width || '800'
  );
  requestAnimationFrame(()=> zoom.fitToWidth(firstWidth));
  setTimeout(()=> zoom.fitToWidth(firstWidth), 120);

  return CURRENT_PDF.wraps.map((wrap,i)=>({ wrap, vpCSS: CURRENT_PDF.vpCSSByPage[i] }));
}

// === Save flattened PDF ===
async function saveFlattened(){
  if (!CURRENT_PDF.bytes){ toast('Open a PDF first', 'err'); return; }
  const { PDFDocument, rgb, StandardFonts } = await import('https://cdn.skypack.dev/pdf-lib');
  const pdf = await PDFDocument.load(CURRENT_PDF.bytes);
  const pages = pdf.getPages();

  CURRENT_PDF.wraps.forEach((wrap, idx)=>{
    const overlay = wrap.querySelector('.overlay'); if (!overlay) return;
    const page = pages[idx];
    const pageSize = { w: page.getWidth(), h: page.getHeight() };
    const vp = CURRENT_PDF.vpCSSByPage[idx];
    overlay.querySelectorAll('.anno').forEach(el=>{
      const r = el.getBoundingClientRect();
      const or = overlay.getBoundingClientRect();
      const fx = pageSize.w / vp.width;
      const fy = pageSize.h / vp.height;

      const x = (r.left - or.left) * fx;
      const y = pageSize.h - ((r.top - or.top) + r.height) * fy;
      const w = Math.max(1, r.width * fx);
      const h = Math.max(1, r.height * fy);

      if (el.classList.contains('text')){
        const cs = getComputedStyle(el);
        const size = parseFloat(cs.fontSize)||16;
        const [rr,gg,bb] = (cs.color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
        const bold = (parseInt(cs.fontWeight,10)||400) >= 600;
        const fontName = bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
        pdf.embedFont(fontName).then(font=>{
          page.drawText(el.textContent||'', { x, y, size: size*fx, font, color: rgb(rr,gg,bb) });
        });
      } else if (el.classList.contains('stamp')){
        const stroke = rgb(0,0,0);
        const x1=x, y1=y + h*0.45, x2=x + w*0.35, y2=y + h*0.15, x3=x + w, y3=y + h*0.85;
        page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:2*fx, color:stroke });
        page.drawLine({ start:{x:x2,y:y2}, end:{x:x3,y:y3}, thickness:2*fx, color:stroke });
      } else if (el.classList.contains('sign')){
        const img = el.querySelector('img'); if (!img) return;
        const bin = atob((img.src||'').split(',')[1]||'');
        const bytes = new Uint8Array(bin.length); for (let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i);
        pdf.embedPng(bytes).then(png=> page.drawImage(png, { x, y, width:w, height:h }) );
      }
    });
  });

  await new Promise(r=>setTimeout(r,0));
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
    }catch(e){}
  }
  const blob = new Blob([out], { type:'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = defaultName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=> URL.revokeObjectURL(a.href), 1200);
  toast('Downloaded ✔️');
}

// === Settings panel ===
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

    sizeInp   = $('#ts-size', panel);
    colorInp  = $('#ts-color', panel);
    boldInp   = $('#ts-bold', panel);
    italicInp = $('#ts-italic', panel);
    familySel = $('#ts-family', panel);
    familySel.value = state.family;

    on(sizeInp,  'input', () => { $('#ts-size-val', panel).textContent = sizeInp.value; apply({size:+sizeInp.value}); }, { passive:true });
    on(colorInp, 'input', () => apply({color:colorInp.value}), { passive:true });
    on(boldInp,  'change',()=> apply({bold:boldInp.checked}));
    on(italicInp,'change',()=> apply({italic:italicInp.checked}));
    on(familySel,'change',()=> apply({family:familySel.value}));
  }
  function apply(part){
    Object.assign(state, part);
    ann.textStyle = { ...ann.textStyle, ...state };
    const el = ann.selected;
    if (el && el.classList.contains('text')) {
      el.style.fontSize = `${Math.max(16, state.size)}px`;
      el.style.color    = state.color;
      el.style.fontWeight = state.bold ? '700':'400';
      el.style.fontStyle  = state.italic? 'italic':'normal';
      el.style.fontFamily = state.family;
      Session.bumpDirty();
    }
  }
  function toggle(){ panel.style.display = panel.style.display==='none' ? 'block' : 'none'; }
  function syncFromElement(el){
    const cs = getComputedStyle(el);
    state.size   = Math.max(16, parseFloat(cs.fontSize)||16);
    state.color  = rgbToHex(cs.color)||'#000000';
    state.bold   = (parseInt(cs.fontWeight,10)||400) >= 600;
    state.italic = cs.fontStyle === 'italic';
    state.family = cs.fontFamily;
    $('#ts-size-val', panel).textContent = state.size;
    $('#ts-size', panel).value = String(state.size);
    $('#ts-color', panel).value = state.color;
    $('#ts-bold', panel).checked = state.bold;
    $('#ts-italic', panel).checked = state.italic;
    $('#ts-family', panel).value = state.family;
    ann.textStyle = { ...state };
  }
  const rgbToHex = (rgb)=>{
    const m = rgb.match(/\d+/g); if (!m) return '#000000';
    const [r,g,b] = m.map(n=>(+n)|0); return '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  };
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
  function bumpDirty(){
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(()=>{ if (dirty){ saveSnapshot(); dirty=false; } }, 600);
  }
  function loadSnapshot(){
    try{ const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; }catch{ return null; }
  }
  function clear(){ try{ localStorage.removeItem(KEY); }catch{} }
  return { bumpDirty, loadSnapshot, clear };
})();

// === Wire UI ===
function wireUI(){
  on(refs.openBtn, 'click', ()=> refs.fileInput?.click());

  // STAGED open handler: only toast on true render failure
  on(refs.fileInput, 'change', async (e)=>{
    const file = e.target.files?.[0]; if (!file) return;

    let infos = [];
    try { infos = await renderPdfFromFile(file, refs.container, 1.5); }
    catch (err) { console.error('PDF open failed:', err); }

    if (!infos || !infos.length){ toast('Could not open PDF', 'err'); return; }

    try { ann.attachOverlays(infos); } catch (attachErr) { console.warn('Overlay attach issue:', attachErr); }
    toast('PDF loaded ✔️');

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
  on(refs.helpBtn,  'click', ()=> toast('📂 Open a PDF. Text: double‑tap/click; Stamp: tap; Signature: draw → Use. Drag to move; Save to flatten.', 'ok', 3800));
  on(refs.settingsBtn, 'click', ()=> { Settings.toggle(); if (ann.selected && ann.selected.classList.contains('text')) Settings.syncFromElement(ann.selected); });
  on(refs.saveBtn,     'click', saveFlattened);

  // Signature modal controls
  on(refs.sigUse,   'click', ()=> sigCtl.use());
  on(refs.sigClear, 'click', ()=> sig.clear());
  on(refs.sigCancel,'click', ()=> sigCtl.close());
}
wireUI();

// Startup restore hint (if any)
(function promptRestoreOnStartup(){
  const snap = Session.loadSnapshot(); if (!snap) return;
  refs.restoreText.textContent = `Previous session found for “${snap.filename}”. Open that PDF to restore?`;
  refs.restoreBanner.style.display = 'flex';
  once(refs.restoreYes,'click', ()=>{
    refs.restoreBanner.style.display='none';
    toast('Open the same PDF file to restore your work.');
  });
  once(refs.restoreNo,'click', ()=>{
    refs.restoreBanner.style.display='none';
    Session.clear();
    toast('Discarded previous session');
  });
})();

// Re-fit on resize/orientation (iOS browser chrome changes)
addEventListener('resize', ()=>{
  const w = CURRENT_PDF.vpCSSByPage[0]?.width;
  if (w) requestAnimationFrame(()=> zoom.fitToWidth(w));
}, { passive:true });

// Optional: suppress benign rejections
window.addEventListener('unhandledrejection', (ev) => {
  const msg = String(ev.reason?.message || ev.reason || '');
  if (msg.includes('Rendering cancelled') || msg.includes('AbortError')) {
    ev.preventDefault();
    console.debug('Suppressed benign rejection:', msg);
  }
});
