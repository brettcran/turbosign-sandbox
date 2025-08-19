// lib/app/app.mjs  — only relevant parts shown are UPDATED
// (If you prefer one file, you can replace your whole app.mjs with this; it's complete.)

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

// ---------- helpers / refs / zoom / settings / session / rendering / saving ----------
// (unchanged from previous message — keep your current versions)
// ... [keep the rest of your file here unchanged up to the Annotations class] ...

// === Annotations (only _addSignature updated to clamp & center) ===
class Annotations {
  constructor(container){
    // ... unchanged ...
  }
  // ... other methods unchanged ...

  _addSignature(overlay, cx, cy, dataURL, widthHint){
    // cx, cy are desired CENTER (unscaled overlay coords)
    const el = document.createElement('div');
    el.className='anno sign';
    overlay.appendChild(el);

    const img = new Image();
    img.draggable = false;
    img.src = dataURL;
    img.style.display = 'block';
    el.appendChild(img);

    this._wireAnno(el, overlay, {resizable:true});

    img.onload = ()=>{
      const maxW = widthHint || Math.min(overlay.clientWidth * 0.5, img.naturalWidth);
      const r = maxW / img.naturalWidth;
      const w = Math.max(24, Math.min(maxW, overlay.clientWidth));   // planned width
      const h = img.naturalHeight * r;

      // place by CENTER, then clamp fully inside overlay bounds
      let left = cx - w / 2;
      let top  = cy - h / 2;

      const maxLeft = overlay.clientWidth  - w;
      const maxTop  = overlay.clientHeight - h;
      left = Math.max(0, Math.min(left, maxLeft));
      top  = Math.max(0, Math.min(top,  maxTop));

      img.style.width  = w + 'px';
      img.style.height = 'auto';
      el.style.left = left + 'px';
      el.style.top  = top  + 'px';

      // Bring into view (center-ish) after placement
      try {
        const pageRect = overlay.getBoundingClientRect();
        const targetX = (left + w/2) * zoom.scale + pageRect.left;
        const targetY = (top  + h/2) * zoom.scale + pageRect.top;

        const dx = targetX - (window.innerWidth  / 2);
        const dy = targetY - (window.innerHeight / 2);
        refs.scroll.scrollLeft += dx;
        refs.scroll.scrollTop  += dy;
      } catch {}
    };

    this._recordAdd(overlay, el);
  }

  // ... rest of Annotations (drag/resize/serialize/etc) unchanged ...
}

// keep the existing instantiation:
const ann = new Annotations($('#pdf-container'));

// === Signature Pad / controller ===
// (Pad unchanged) — only SigController.use is updated below

class SigController {
  constructor(sig, ann){ this.sig=sig; this.ann=ann; }
  open(){ this.sig.open(); }
  close(){ this.sig.close(); }

  // UPDATED: choose overlay at viewport center + convert to overlay coords
  use(){
    const centerClientX = window.innerWidth  / 2;
    const centerClientY = window.innerHeight / 2;

    // Get the .overlay element that sits under the viewport center
    let node = document.elementFromPoint(centerClientX, centerClientY);
    let overlay = null;
    while (node) {
      if (node.classList && node.classList.contains('overlay')) { overlay = node; break; }
      node = node.parentNode;
    }
    if (!overlay) {
      // Fallback: first overlay on current page set
      overlay = ann.overlays[0] || null;
    }
    if (!overlay) { this.close(); return; }

    // Convert viewport center (client) -> overlay local coords (UNSCALED), then drop there
    const r = overlay.getBoundingClientRect();
    const x = (centerClientX - r.left) / zoom.scale;
    const y = (centerClientY - r.top)  / zoom.scale;

    // width hint ~ 40% page width
    const widthHint = overlay.clientWidth * 0.4;
    this.ann._addSignature(overlay, x, y, this.sig.dataURL(), widthHint);
    Session.bumpDirty?.();
    this.close();
  }
}
const sigCtl = new SigController(new (class SigPad{
  constructor(){
    this.canvas = $('#sig-pad'); this.modal = $('#sign-modal');
    this.ctx = this.canvas.getContext('2d'); this._wire();
  }
  _wire(){
    this.clear();
    let drawing=false;
    const pos = (ev)=>{ const r=this.canvas.getBoundingClientRect(); const dpr=Math.max(1,devicePixelRatio||1); return { x:(ev.clientX-r.left)*dpr, y:(ev.clientY-r.top)*dpr }; };
    on(this.canvas,'pointerdown',(e)=>{ this.canvas.setPointerCapture?.(e.pointerId); drawing=true; const p=pos(e); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(this.canvas,'pointermove',(e)=>{ if(!drawing) return; const p=pos(e); this.ctx.lineTo(p.x,p.y); this.ctx.stroke(); this.ctx.beginPath(); this.ctx.moveTo(p.x,p.y); });
    on(this.canvas,'pointerup',  ()=>{ drawing=false; });
  }
  open(){ this.modal.classList.add('show'); }
  close(){ this.modal.classList.remove('show'); }
  clear(){
    const dpr = Math.max(1, devicePixelRatio||1);
    this.canvas.width = 500*dpr; this.canvas.height=200*dpr;
    this.canvas.style.width='500px'; this.canvas.style.height='200px';
    const c=this.ctx; c.setTransform(1,0,0,1,0,0);
    c.clearRect(0,0,this.canvas.width,this.canvas.height); // keep transparent bitmap
    c.lineWidth=2.5*dpr; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round';
  }
  dataURL(){ return this.canvas.toDataURL('image/png'); }
})(), ann);

// ---------- rest of the file (UI wiring, renderPdfFromFile, saveFlattened, Settings, Session, toasts, etc.) stays the same ----------

// Wire UI (ensure button handlers present)
(function wireUI(){
  const refs = {
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
    sigUse:    $('#sig-use'),
    sigClear:  $('#sig-clear'),
    sigCancel: $('#sig-cancel'),
    restoreBanner: $('#restore-banner'),
    restoreText: $('#restore-text'),
    restoreYes: $('#restore-yes'),
    restoreNo:  $('#restore-no')
  };

  on(refs.signBtn,  'click', ()=>{ ann.setMode(null); sigCtl.open(); });
  on(refs.sigUse,   'click', (e)=>{ e.stopPropagation(); sigCtl.use();   });
  on(refs.sigClear, 'click', (e)=>{ e.stopPropagation(); sigCtl.clear?.(); });
  on(refs.sigCancel,'click', (e)=>{ e.stopPropagation(); sigCtl.close(); });

  // ... keep your other handlers (open file, text, stamp, undo/redo, save, settings, etc.)
})();
