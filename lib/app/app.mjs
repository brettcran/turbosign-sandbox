/* lib/app/app.js — ESM, integrated fixes */

// ===== PDF.js — your tree: lib/build/ =====
let pdfjsLib;
try {
  pdfjsLib = await import('../build/pdf.mjs'); // local ESM
} catch (e) {
  console.error('Failed to import local pdf.mjs', e);
  pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs');
}

// Try module worker first; fall back to workerSrc
(() => {
  const workerURL = new URL('../build/pdf.worker.mjs', import.meta.url);
  try {
    const test = new Worker(workerURL, { type: 'module' });
    test.terminate();
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(workerURL, { type: 'module' });
  } catch (err) {
    console.warn('Module worker failed; falling back to workerSrc', err);
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerURL.href;
  }
})();

// ===== helpers =====
const $ = (s, r=document) => r.querySelector(s);
const on = (el, ev, cb, opts) => el && el.addEventListener(ev, cb, opts);
const once = (el, ev, cb, opts) => el && el.addEventListener(ev, function h(e){ el.removeEventListener(ev, h, opts); cb(e); }, opts);
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
const toast = (msg, kind='ok', t=2400) => { const n=$('#toast'); if(!n) return; n.textContent=msg; n.className=''; n.classList.add('show',kind); clearTimeout(n._t); n._t=setTimeout(()=>{n.className='';},t); };

// ===== refs =====
const refs = {
  stage: $('#pdf-stage'), scroll: $('#pdf-scroll'), container: $('#pdf-container'),
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
  sigModal:  $('#sign-modal'), sigPad: $('#sig-pad'),
  sigUse: $('#sig-use'), sigClear: $('#sig-clear'), sigCancel: $('#sig-cancel'),
  restoreBanner: $('#restore-banner'), restoreText: $('#restore-text'), restoreYes: $('#restore-yes'), restoreNo: $('#restore-no'),
};

// keep original file + render info
let CURRENT_PDF = { file:null, bytes:null, filename:null, wraps:[], vpCSSByPage:[] };

// ===== Zoom (pinch + ctrl/⌘+wheel) =====
class Zoom {
  constructor(container, scroll){
    this.container=container; this.scroll=scroll;
    this.scale=1; this.min=0.6; this.max=3; this.suspended=false;
    this._pts=new Map(); this._pinching=false; this._lastDist=0; this._cx=0; this._cy=0;
    container.style.transformOrigin='0 0';
    on(scroll,'wheel',e=>this._onWheel(e),{passive:false});
    on(scroll,'pointerdown',e=>this._pd(e));
    on(scroll,'pointermove',e=>this._pm(e));
    on(scroll,'pointerup',  e=>this._pu(e));
    on(scroll,'pointercancel',e=>this._pu(e));
  }
  suspend(v){this.suspended=!!v;}
  setScale(newScale,cx,cy,keepCenter=true){
    newScale=Math.max(this.min,Math.min(this.max,newScale));
    if(newScale===this.scale) return;
    const rect=this.container.getBoundingClientRect();
    const sx=(cx-rect.left+this.scroll.scrollLeft)/this.scale;
    const sy=(cy-rect.top +this.scroll.scrollTop )/this.scale;
    this.scale=newScale;
    this.container.style.transform=`scale(${this.scale})`;
    if(keepCenter){
      const nx=sx*this.scale-(cx-rect.left), ny=sy*this.scale-(cy-rect.top);
      this.scroll.scrollLeft=nx; this.scroll.scrollTop=ny;
    }
  }
  _onWheel(e){ if(this.suspended) return; if(!(e.ctrlKey||e.metaKey)) return; e.preventDefault(); this.setScale(this.scale*(e.deltaY<0?1.1:0.9), e.clientX, e.clientY, true); }
  _pd(e){ if(this.suspended) return; this._pts.set(e.pointerId,e); if(this._pts.size===2){ this._pinching=true; const[a,b]=[...this._pts.values()]; this._lastDist=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); this._cx=(a.clientX+b.clientX)/2; this._cy=(a.clientY+b.clientY)/2; } }
  _pm(e){ if(this.suspended) return; if(!this._pts.has(e.pointerId)) return; this._pts.set(e.pointerId,e); if(this._pinching&&this._pts.size===2){ const[a,b]=[...this._pts.values()]; const d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); if(this._lastDist){ this.setScale(this.scale*(d/this._lastDist), this._cx, this._cy, true);} this._lastDist=d; } }
  _pu(e){ this._pts.delete(e.pointerId); if(this._pts.size<2){ this._pinching=false; this._lastDist=0; } }
}
const zoom = new Zoom(refs.container, refs.scroll);

// center horizontally at current zoom
function centerHorizontally(){
  const w = CURRENT_PDF.vpCSSByPage[0]?.width ||
    parseFloat(CURRENT_PDF.wraps[0]?.querySelector('canvas')?.style.width||'0');
  if(!w) return;
  refs.scroll.scrollLeft = Math.max(0, (w*zoom.scale - refs.scroll.clientWidth)/2);
}
on(window,'resize', centerHorizontally);

// ===== Annotations (text has NO resize) =====
class Annotations {
  constructor(container){
    this.container=container;
    this.mode=null;
    this.history=[]; this.redoStack=[];
    this.overlays=[]; this.selected=null;
    this.textStyle={ size:16, color:'#000', bold:false, italic:false, family:'Arial, sans-serif' };
    this.drag={ el:null, overlay:null, dx:0, dy:0 };
    this.resize={ el:null, overlay:null, startW:0, startH:0, sx:0, sy:0 };
    on(document,'pointermove',e=>this._onMove(e),{passive:false});
    on(document,'pointerup',  e=>this._onUp(e));
  }
  setMode(m){ this.mode=m; this._select(null); }
  attachOverlays(wrapInfos){
    this.overlays.forEach(ov=>ov.remove());
    this.overlays=[];
    wrapInfos.forEach(({wrap})=>{
      const ov=document.createElement('div'); ov.className='overlay'; wrap.appendChild(ov);

      on(ov,'pointerdown', e=>{ if(e.target===ov) this._select(null); }, {passive:true});

      on(ov,'dblclick', e=>{
        if(this.mode!=='text' || e.target!==ov) return;
        const {x,y}=this._pos(ov,e); this._addText(ov,x,y,true); Session.bumpDirty?.();
      });
      if(isTouch){
        let t=0,lx=0,ly=0;
        on(ov,'pointerdown',e=>{
          if(this.mode!=='text' || e.pointerType!=='touch') return;
          const now=performance.now(); const {x,y}=this._pos(ov,e);
          if(now-t<300 && Math.abs(x-lx)<24 && Math.abs(y-ly)<24){
            this._addText(ov,x,y,true); Session.bumpDirty?.(); t=0;
          } else { t=now; lx=x; ly=y; }
        }, {passive:true});
      }

      on(ov,'pointerdown', e=>{
        if(this.mode!=='stamp' || e.target!==ov) return;
        const {x,y}=this._pos(ov,e); this._addStamp(ov,x,y); Session.bumpDirty?.();
      }, {passive:true});

      this.overlays.push(ov);
    });
  }

  _pos(overlay,e){ const r=overlay.getBoundingClientRect(); return { x:(e.clientX-r.left)/zoom.scale, y:(e.clientY-r.top)/zoom.scale }; }
  _elSize(el){ return { w: el.offsetWidth, h: el.offsetHeight }; }

  _addText(overlay,x,y,focus){
    const el=document.createElement('div');
    el.className='anno text'; el.contentEditable='true';
    el.style.left=`${x}px`; el.style.top=`${y}px`;
    const st=this.textStyle;
    el.style.color=st.color; el.style.fontSize=`${Math.max(16,st.size)}px`;
    el.style.fontWeight=st.bold?'700':'400'; el.style.fontStyle=st.italic?'italic':'normal';
    el.style.fontFamily=st.family;
    overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:false}); // no resize for text
    if(focus) this._focus(el);
    this._recordAdd(overlay, el);
  }
  _addStamp(overlay,x,y){
    const el=document.createElement('div');
    el.className='anno stamp'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    el.innerHTML=`<svg viewBox="0 0 24 24" width="24" height="24" style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M4 12l4 4 12-12"/></svg>`;
    overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:false});
    this._recordAdd(overlay, el);
  }
  _addSignature(overlay,x,y,dataURL,widthHint){
    const el=document.createElement('div');
    el.className='anno sign'; el.style.left=`${x}px`; el.style.top=`${y}px`;
    const img=new Image(); img.draggable=false; img.src=dataURL; img.style.display='block';
    el.appendChild(img); overlay.appendChild(el);
    this._wireAnno(el, overlay, {resizable:true}); // signatures resizable
    img.onload=()=>{
      const maxW=widthHint || Math.min(overlay.clientWidth*0.6, img.naturalWidth||img.width||300);
      const r=maxW/(img.naturalWidth||maxW); img.width=maxW; img.height=(img.naturalHeight||maxW*0.35)*r;
    };
    this._recordAdd(overlay, el);
  }

  _wireAnno(el, overlay, {resizable}){
    const startDrag=(e)=>{
      if(el.classList.contains('text') && document.activeElement===el){ this._select(el); return; }
      const {x,y}=this._pos(overlay,e);
      const left=parseFloat(el.style.left)||0; const top=parseFloat(el.style.top)||0;
      this.drag={ el, overlay, dx:x-left, dy:y-top };
      $('#pdf-scroll').style.touchAction='none'; zoom.suspend(true);
      el.setPointerCapture?.(e.pointerId); this._select(el); e.preventDefault();
    };
    on(el,'pointerdown', startDrag, {passive:false});
    const innerImg=el.querySelector('img'); if(innerImg) on(innerImg,'pointerdown', startDrag, {passive:false});

    if(el.classList.contains('text')){
      on(el,'dblclick',()=>{ this._focus(el); this._select(el); });
      on(el,'input',()=> Session.bumpDirty?.());
    }

    if(resizable && !el.classList.contains('text')){
      const h=document.createElement('div'); h.className='handle br'; el.appendChild(h);
      on(h,'pointerdown',e=>{
        e.stopPropagation();
        const { w, h:hh } = this._elSize(el);
        this.resize={ el, overlay, startW:w, startH:hh, sx:e.clientX, sy:e.clientY };
        $('#pdf-scroll').style.touchAction='none'; zoom.suspend(true);
        h.setPointerCapture?.(e.pointerId);
      }, {passive:false});
    }
  }
  _onMove(e){
    if(this.drag.el){
      const {x,y}=this._pos(this.drag.overlay,e);
      let nx=x-this.drag.dx, ny=y-this.drag.dy;
      const W=this.drag.overlay.clientWidth, H=this.drag.overlay.clientHeight;
      const {w:ew,h:eh}=this._elSize(this.drag.el);
      nx=Math.max(0,Math.min(nx,W-ew)); ny=Math.max(0,Math.min(ny,H-eh));
      this.drag.el.style.left=`${nx}px`; this.drag.el.style.top=`${ny}px`;
      e.preventDefault(); return;
    }
    if(this.resize.el){
      const dx=(e.clientX-this.resize.sx)/zoom.scale;
      const w=Math.max(24,this.resize.startW+dx);
      const el=this.resize.el;
      const img=el.querySelector('img'); if(img){ img.style.width=w+'px'; img.style.height='auto'; }
      e.preventDefault();
    }
  }
  _onUp(e){
    const changed=this.drag.el||this.resize.el;
    if(this.drag.el){ try{this.drag.el.releasePointerCapture?.(e.pointerId)}catch{}; this.drag={el:null,overlay:null,dx:0,dy:0}; }
    if(this.resize.el){ try{this.resize.el.releasePointerCapture?.(e.pointerId)}catch{}; this.resize={el:null,overlay:null,startW:0,startH:0,sx:0,sy:0}; }
    $('#pdf-scroll').style.touchAction='pan-y'; zoom.suspend(false);
    if(changed) Session.bumpDirty?.();
  }

  _focus(el){ el.focus(); const sel=getSelection(); const range=document.createRange(); range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); }
  _select(el){ this.container.querySelectorAll('.anno').forEach(n=>n.classList.remove('selected')); this.selected=el; if(el) el.classList.add('selected'); }

  undo(){ const last=this.history.pop(); if(!last) return; if(last.el?.parentNode){ last.el.parentNode.removeChild(last.el); if(this.selected===last.el) this._select(null); this.redoStack.push(last);} Session.bumpDirty?.(); }
  redo(){ const next=this.redoStack.pop(); if(!next) return; if(next.el){ next.overlay.appendChild(next.el); this.history.push(next);} Session.bumpDirty?.(); }
  _recordAdd(overlay, el){ this.history.push({type:'add',overlay,el}); this.redoStack.length=0; }

  serialize(){
    return this.overlays.map(ov=>{
      const annos=[]; ov.querySelectorAll('.anno').forEach(el=>{
        const base={ x:el.offsetLeft, y:el.offsetTop, w:el.offsetWidth, h:el.offsetHeight };
        if(el.classList.contains('text')){
          const cs=getComputedStyle(el);
          annos.push({ kind:'text', ...base, text:el.textContent||'', style:{
            size:parseFloat(cs.fontSize)||16, color:cs.color,
            bold:(parseInt(cs.fontWeight,10)||400)>=600, italic:cs.fontStyle==='italic', family:cs.fontFamily
          }});
        } else if(el.classList.contains('stamp')){
          annos.push({ kind:'stamp', ...base });
        } else {
          const img=el.querySelector('img'); annos.push({ kind:'sign', ...base, dataURL: img?.src||'' });
        }
      });
      return { annos };
    });
  }
  async deserialize(pages){
    if(!pages) return;
    this.overlays.forEach(ov=>ov.innerHTML='');
    pages.forEach((pg,i)=>{
      const ov=this.overlays[i]; if(!ov) return;
      pg.annos?.forEach(a=>{
        if(a.kind==='text'){
          const el=document.createElement('div'); el.className='anno text'; el.contentEditable='true';
          el.style.left=`${a.x}px`; el.style.top=`${a.y}px`;
          const st=a.style||{};
          el.style.fontSize=`${Math.max(16,st.size||16)}px`;
          el.style.color=st.color||'#000';
          el.style.fontWeight=st.bold?'700':'400';
          el.style.fontStyle=st.italic?'italic':'normal';
          el.style.fontFamily=st.family||'Arial, sans-serif';
          el.textContent=a.text||'';
          ov.appendChild(el);
          this._wireAnno(el, ov, {resizable:false});
        } else if(a.kind==='stamp'){
          const el=document.createElement('div'); el.className='anno stamp';
          el.style.left=`${a.x}px`; el.style.top=`${a.y}px`;
          el.innerHTML=`<svg viewBox="0 0 24 24" width="${Math.max(16,a.w)}" height="${Math.max(16,a.h)}" style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M4 12l4 4 12-12"/></svg>`;
          ov.appendChild(el); this._wireAnno(el, ov, {resizable:false});
        } else {
          const el=document.createElement('div'); el.className='anno sign';
          el.style.left=`${a.x}px`; el.style.top=`${a.y}px`;
          const img=new Image(); img.draggable=false; img.src=a.dataURL||''; img.style.display='block';
          img.style.width=`${Math.max(24,a.w)}px`; img.style.height='auto';
          el.appendChild(img); ov.appendChild(el);
          this._wireAnno(el, ov, {resizable:true});
        }
      });
    });
  }
}
const ann = new Annotations(refs.container);

// ===== Signature Pad (white UI; transparent bitmap) =====
class SigPad{
  constructor(canvas, modal){ this.canvas=canvas; this.modal=modal; this.ctx=canvas.getContext('2d'); this.clear();
    this.drawing=false;
    const pos=ev=>{ const r=canvas.getBoundingClientRect(); const dpr=Math.max(1,devicePixelRatio||1); return {x:(ev.clientX-r.left)*dpr,y:(ev.clientY-r.top)*dpr}; };
    on(canvas,'pointerdown',e=>{ canvas.setPointerCapture?.(e.pointerId); this.drawing=true; const p=pos(e); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y);});
    on(canvas,'pointermove',e=>{ if(!this.drawing) return; const p=pos(e); this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y);});
    on(canvas,'pointerup', ()=>{ this.drawing=false; });
  }
  open(){ this.modal.classList.add('show'); }
  close(){ this.modal.classList.remove('show'); }
  clear(){ const dpr=Math.max(1,devicePixelRatio||1);
    this.canvas.width=500*dpr; this.canvas.height=200*dpr; this.canvas.style.width='500px'; this.canvas.style.height='200px';
    const c=this.ctx; c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,this.canvas.width,this.canvas.height);
    c.lineWidth=2.5*dpr; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round';
  }
  dataURL(){ return this.canvas.toDataURL('image/png'); }
}
const sig = new SigPad(refs.sigPad, refs.sigModal);

class SigController{
  constructor(sig,ann){ this.sig=sig; this.ann=ann; }
  open(){ this.sig.open(); }
  close(){ this.sig.close(); }
  use(){
    let target=ann.overlays[0]||null;
    if(ann.overlays.length){
      const midX=refs.scroll.scrollLeft+refs.scroll.clientWidth/2;
      const midY=refs.scroll.scrollTop +refs.scroll.clientHeight/2;
      target=ann.overlays.find(ov=>{
        const r=ov.getBoundingClientRect(), c=refs.container.getBoundingClientRect();
        const left=r.left-c.left+refs.scroll.scrollLeft, top=r.top-c.top+refs.scroll.scrollTop;
        return midX>=left && midX<=left+r.width && midY>=top && midY<=top+r.height;
      })||target;
    }
    if(!target){ this.close(); return; }
    const rect=target.getBoundingClientRect();
    const x=(rect.width/zoom.scale)*0.5, y=(rect.height/zoom.scale)*0.5;
    this.ann._addSignature(target,x,y,this.sig.dataURL(), (rect.width/zoom.scale)*0.5);
    Session.bumpDirty?.(); this.close();
  }
}
const sigCtl=new SigController(sig, ann);
refs.sigModal?.classList.remove('show');

// ===== PDF render @ 1:1 =====
async function renderPdfFromFile(file, container, scale=1){
  // keep original file to re-read for saving if needed
  CURRENT_PDF.file = file;
  const bytes=new Uint8Array(await file.arrayBuffer());
  CURRENT_PDF.bytes=bytes; CURRENT_PDF.filename=file.name||'document.pdf';
  return renderPdfFromData(bytes, container, scale);
}
async function renderPdfFromData(bytes, container, scale=1){
  container.innerHTML=''; CURRENT_PDF.wraps=[]; CURRENT_PDF.vpCSSByPage=[];
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    console.error('getDocument failed', err);
    toast('Could not start PDF engine', 'err');
    throw err;
  }
  const ratio=Math.max(1,Math.min(2,devicePixelRatio||1));
  for(let i=1;i<=pdf.numPages;i++){
    try{
      const page=await pdf.getPage(i);
      const vpCSS=page.getViewport({scale});
      const vpDev=page.getViewport({scale:scale*ratio});
      const wrap=document.createElement('div'); wrap.className='page-wrap';
      const canvas=document.createElement('canvas'); canvas.className='pdfpage';
      canvas.width=Math.floor(vpDev.width); canvas.height=Math.floor(vpDev.height);
      canvas.style.width=vpCSS.width+'px'; canvas.style.height=vpCSS.height+'px';
      wrap.appendChild(canvas); container.appendChild(wrap);
      const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
      await page.render({canvasContext:ctx, viewport:vpDev, intent:'display'}).promise;
      CURRENT_PDF.wraps.push(wrap); CURRENT_PDF.vpCSSByPage.push({width:vpCSS.width,height:vpCSS.height});
    }catch(e){ console.warn('Page render warning:', e); }
  }
  requestAnimationFrame(centerHorizontally); setTimeout(centerHorizontally,120);
  return CURRENT_PDF.wraps.map((wrap,i)=>({wrap, vpCSS:CURRENT_PDF.vpCSSByPage[i]}));
}

// ===== PDF byte validator =====
function isValidPdfBytes(bytes){
  if (!bytes || !bytes.length) return false;
  const maxSkip = Math.min(8, bytes.length);
  for (let i=0; i<maxSkip; i++){
    if (bytes[i] === 0x25 && bytes[i+1] === 0x50 && bytes[i+2] === 0x44 && bytes[i+3] === 0x46 && bytes[i+4] === 0x2D) {
      return true; // %PDF-
    }
  }
  return false;
}

// ===== Robust pdf-lib ESM loader (CDN fallbacks) =====
async function loadPdfLibESM(){
  try { return await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm'); }
  catch (e) { console.warn('pdf-lib jsDelivr +esm failed, trying unpkg…', e); }
  try { return await import('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js?module'); }
  catch (e) { console.warn('pdf-lib unpkg ?module failed, trying Skypack…', e); }
  try { return await import('https://cdn.skypack.dev/pdf-lib@1.17.1'); }
  catch (e) { console.error('All pdf-lib CDNs failed', e); throw new Error('Unable to load pdf-lib ESM from CDN'); }
}

// ===== Save (guarded + self-heal bytes) =====
async function saveFlattened(){
  if (!CURRENT_PDF.bytes && !CURRENT_PDF.file){ toast('Open a PDF first','err'); return; }

  // Validate & recover bytes if needed
  try {
    if (!isValidPdfBytes(CURRENT_PDF.bytes)) {
      if (CURRENT_PDF.file) {
        const fresh = new Uint8Array(await CURRENT_PDF.file.arrayBuffer());
        if (isValidPdfBytes(fresh)) CURRENT_PDF.bytes = fresh;
        else throw new Error('Read file but it is not a valid PDF');
      } else {
        throw new Error('Invalid in-memory PDF buffer and no file handle');
      }
    }
  } catch (rehydrateErr) {
    console.error('PDF buffer recovery failed:', rehydrateErr);
    toast('Could not read the original PDF. Please re-open the file and try again.', 'err', 3800);
    return;
  }

  // Load pdf-lib
  let mod, PDFDocument, rgb, StandardFonts;
  try {
    mod = await loadPdfLibESM();
    PDFDocument   = mod.PDFDocument   || mod.default?.PDFDocument;
    rgb           = mod.rgb           || mod.default?.rgb;
    StandardFonts = mod.StandardFonts || mod.default?.StandardFonts;
    if (!PDFDocument || !rgb || !StandardFonts) throw new Error('pdf-lib exports missing');
  } catch (e) {
    console.error(e); toast('Could not load save engine','err'); return;
  }

  try{
    const pdf  = await PDFDocument.load(CURRENT_PDF.bytes);
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const helvB= await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages= pdf.getPages();
    const embedOps = [];

    CURRENT_PDF.wraps.forEach((wrap, idx)=>{
      const overlay = wrap.querySelector('.overlay'); if(!overlay) return;
      const page = pages[idx];
      const pageW = page.getWidth(), pageH = page.getHeight();
      const vp = CURRENT_PDF.vpCSSByPage[idx];
      const fx = pageW / vp.width, fy = pageH / vp.height;

      overlay.querySelectorAll('.anno').forEach(el=>{
        const left=el.offsetLeft, top=el.offsetTop, w=el.offsetWidth, h=el.offsetHeight;
        const x=left*fx, y=pageH-(top+h)*fy;

        if (el.classList.contains('text')){
          const cs = getComputedStyle(el);
          const size = (parseFloat(cs.fontSize)||16) * fx;
          const [r,g,b] = (cs.color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
          const font = (parseInt(cs.fontWeight,10)||400) >= 600 ? helvB : helv;
          page.drawText(el.textContent||'', { x, y, size, font, color: rgb(r,g,b) });
        } else if (el.classList.contains('stamp')){
          const stroke = rgb(0,0,0);
          const x1=x, y1=y+h*fy*0.45, x2=x+w*fx*0.35, y2=y+h*fy*0.15, x3=x+w*fx, y3=y+h*fy*0.85;
          page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:2*fx, color:stroke });
          page.drawLine({ start:{x:x2,y:y2}, end:{x:x3,y:y3}, thickness:2*fx, color:stroke });
        } else {
          // Signature (PNG with alpha)
          const img = el.querySelector('img'); if (!img) return;
          const p = (async ()=>{
            try{
              let bytes;
              if (img.src.startsWith('data:')){
                const b64=(img.src.split(',')[1]||''); const bin=atob(b64);
                bytes=new Uint8Array(bin.length); for(let i=0;i<bytes.length;i++) bytes[i]=bin.charCodeAt(i);
              } else {
                const res=await fetch(img.src,{mode:'cors'}); bytes=new Uint8Array(await res.arrayBuffer());
              }
              const png = await pdf.embedPng(bytes);
              page.drawImage(png, { x, y, width:w*fx, height:h*fy });
            }catch(err){ console.warn('Signature embed failed:', err); }
          })();
          embedOps.push(p);
        }
      });
    });

    if (embedOps.length) await Promise.all(embedOps);
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
      }catch{/* fallback */}
    }
    const blob = new Blob([out], { type:'application/pdf' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = defaultName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1200);
    toast('Downloaded ✔️');
  }catch(e){
    console.error('Save failed:', e);
    toast('Could not save PDF', 'err');
  }
}

// ===== Settings (text only) =====
const Settings=(()=>{
  let panel,sizeInp,colorInp,boldInp,italicInp,familySel;
  const state={ size:16, color:'#000000', bold:false, italic:false, family:'Arial, sans-serif' };
  function build(){
    panel=document.createElement('div');
    Object.assign(panel.style,{
      position:'fixed', right:'12px', bottom:'calc(88px + env(safe-area-inset-bottom,0px))', zIndex:'60',
      background:'rgba(20,24,32,.94)', border:'1px solid rgba(255,255,255,.14)', borderRadius:'12px',
      padding:'10px', minWidth:'240px', display:'none', color:'#e9eef5', font:'13px system-ui, sans-serif'
    });
    panel.innerHTML=`
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
      </div>`;
    document.body.appendChild(panel);

    sizeInp=panel.querySelector('#ts-size'); colorInp=panel.querySelector('#ts-color');
    boldInp=panel.querySelector('#ts-bold'); italicInp=panel.querySelector('#ts-italic');
    familySel=panel.querySelector('#ts-family');

    const apply=part=>{
      Object.assign(state,part);
      ann.textStyle={...ann.textStyle,...state};
      const el=ann.selected;
      if(el?.classList.contains('text')){
        el.style.fontSize=`${Math.max(16,state.size)}px`;
        el.style.color=state.color;
        el.style.fontWeight=state.bold?'700':'400';
        el.style.fontStyle=state.italic?'italic':'normal';
        el.style.fontFamily=state.family;
        Session.bumpDirty?.();
      }
    };
    on(sizeInp,'input',()=>{ panel.querySelector('#ts-size-val').textContent=sizeInp.value; apply({size:+sizeInp.value}); }, {passive:true});
    on(colorInp,'input',()=>apply({color:colorInp.value}), {passive:true});
    on(boldInp,'change',()=>apply({bold:boldInp.checked}));
    on(italicInp,'change',()=>apply({italic:italicInp.checked}));
    on(familySel,'change',()=>apply({family:familySel.value}));
  }
  function toggle(){ panel.style.display=panel.style.display==='none'?'block':'none'; }
  function syncFromElement(el){
    const cs=getComputedStyle(el);
    const rgbToHex=rgb=>{ const m=rgb.match(/\d+/g); if(!m) return '#000000'; const [r,g,b]=m.map(n=>(+n)|0); return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join(''); };
    const next={ size:Math.max(16,parseFloat(cs.fontSize)||16), color:rgbToHex(cs.color)||'#000000', bold:(parseInt(cs.fontWeight,10)||400)>=600, italic:cs.fontStyle==='italic', family:cs.fontFamily };
    Object.assign(state,next);
    panel.querySelector('#ts-size').value=String(state.size);
    panel.querySelector('#ts-size-val').textContent=state.size;
    panel.querySelector('#ts-color').value=state.color;
    panel.querySelector('#ts-bold').checked=state.bold;
    panel.querySelector('#ts-italic').checked=state.italic;
    panel.querySelector('#ts-family').value=state.family;
    ann.textStyle={...state};
  }
  return { build, toggle, syncFromElement };
})();
Settings.build();

// ===== Session =====
const Session=(()=>{
  const KEY='turbosign.session.v1'; let dirty=false, timer=null;
  function saveSnapshot(){ if(!CURRENT_PDF.filename || !ann.overlays.length) return; const snapshot={ ts:Date.now(), filename:CURRENT_PDF.filename, pages:ann.serialize() }; try{ localStorage.setItem(KEY, JSON.stringify(snapshot)); }catch{} }
  function bumpDirty(){ dirty=true; clearTimeout(timer); timer=setTimeout(()=>{ if(dirty){ saveSnapshot(); dirty=false; }},600); }
  function loadSnapshot(){ try{ const raw=localStorage.getItem(KEY); return raw?JSON.parse(raw):null; }catch{ return null; } }
  function clear(){ try{ localStorage.removeItem(KEY); }catch{} }
  return { bumpDirty, loadSnapshot, clear };
})();

// ===== UI wiring =====
function wireUI(){
  on(refs.openBtn,'click',()=>refs.fileInput?.click());
  on(refs.fileInput,'change',async e=>{
    const file=e.target.files?.[0]; if(!file) return;
    let infos;
    try{ infos=await renderPdfFromFile(file, refs.container, 1); }
    catch(err){
      const msg = String(err?.message||err);
      if (msg.includes('Worker') || msg.includes('loading')) toast('PDF engine failed to start. Refresh and try again.', 'err', 3500);
      else toast('Could not open PDF', 'err', 3000);
      console.error(err);
      return;
    }
    try{ ann.attachOverlays(infos); }catch(e2){ console.warn('Overlay attach issue:', e2); }
    toast('PDF loaded ✔️'); centerHorizontally();

    try{
      const snap=Session.loadSnapshot?.();
      if(snap && snap.filename===(CURRENT_PDF.filename||file.name)){
        refs.restoreText.textContent=`Restore work from last session on “${snap.filename}”?`;
        refs.restoreBanner.style.display='flex';
        once(refs.restoreYes,'click',async ()=>{ refs.restoreBanner.style.display='none'; try{ await ann.deserialize(snap.pages); toast('Session restored ✔️'); }catch(e3){ console.warn('Restore failed:',e3); toast('Could not restore previous session','err'); }});
        once(refs.restoreNo,'click',()=>{ refs.restoreBanner.style.display='none'; Session.clear?.(); toast('Discarded previous session'); });
      }
    }catch(e4){ console.warn('Restore prompt issue:', e4); }
  });

  on(refs.textBtn,'click',()=>{ ann.setMode(ann.mode==='text'?null:'text'); toast(ann.mode?(isTouch?'Text: double‑tap':'Text: double‑click'):'Tool off'); });
  on(refs.stampBtn,'click',()=>{ ann.setMode(ann.mode==='stamp'?null:'stamp'); toast(ann.mode?'Stamp: tap/click':'Tool off'); });
  on(refs.signBtn,'click',()=>{ ann.setMode(null); sigCtl.open(); });

  on(refs.undoBtn,'click',()=>ann.undo());
  on(refs.redoBtn,'click',()=>ann.redo());
  on(refs.helpBtn,'click',()=>toast('📂 Open a PDF. Text: double‑tap/click; Stamp: tap; Signature: draw → Use. Drag; Save to flatten.','ok',3800));
  on(refs.settingsBtn,'click',()=>{ Settings.toggle(); if(ann.selected?.classList.contains('text')) Settings.syncFromElement(ann.selected); });
  on(refs.saveBtn,'click',saveFlattened);

  on(refs.sigUse,'click',e=>{ e.stopPropagation(); sigCtl.use(); });
  on(refs.sigClear,'click',e=>{ e.stopPropagation(); sig.clear(); });
  on(refs.sigCancel,'click',e=>{ e.stopPropagation(); sigCtl.close(); });
}
wireUI();

// Startup hint
(() => {
  const snap=Session.loadSnapshot(); if(!snap) return;
  refs.restoreText.textContent=`Previous session found for “${snap.filename}”. Open that PDF to restore?`;
  refs.restoreBanner.style.display='flex';
  once(refs.restoreYes,'click',()=>{ refs.restoreBanner.style.display='none'; toast('Open the same PDF file to restore your work.'); });
  once(refs.restoreNo,'click',()=>{ refs.restoreBanner.style.display='none'; Session.clear(); toast('Discarded previous session'); });
})();

// Quiet benign promise rejections
addEventListener('unhandledrejection',ev=>{ const m=String(ev.reason?.message||ev.reason||''); if(m.includes('Rendering cancelled')||m.includes('AbortError')) ev.preventDefault(); });
