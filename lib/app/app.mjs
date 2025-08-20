// TurboSign — Canvas-centric build (v4.0 Gold+ center-zoom + signature/photo canvas + ESM)
// PDF.js pages -> canvas, signature drawn on canvas, camera capture via canvas, flatten via pdf-lib.

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.mjs';

async function loadPdfLib() {
  const mod = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
  return { PDFDocument: mod.PDFDocument, rgb: mod.rgb, StandardFonts: mod.StandardFonts };
}

const $ = (s, r=document)=>r.querySelector(s);
const refs = {
  toolbar: $('#toolbar'),
  fileInput: $('#file-input'),
  photoFile: $('#photo-file'),
  scroll: $('#pdf-scroll'),
  scaler: $('#pdf-scaler'),
  container: $('#pdf-container'),
  toast: $('#toast'),
  // signature
  sigModal: $('#sign-modal'), sigPad: $('#sig-pad'),
  sigUse: $('#sig-use'), sigClear: $('#sig-clear'), sigCancel: $('#sig-cancel'),
  // text settings
  textPanel: $('#text-settings'),
  tsSize: $('#ts-size'), tsSizeVal: $('#ts-size-val'), tsColor: $('#ts-color'),
  tsBold: $('#ts-bold'), tsItalic: $('#ts-italic'), tsFamily: $('#ts-family'),
  // photo
  pm: $('#photo-modal'), pmUseCamera: $('#pm-use-camera'), pmChoosePhoto: $('#pm-choose-photo'),
  pmClose: $('#pm-close'), pmCameraSec: $('#pm-camera'), pmFileSec: $('#pm-file'),
  cameraView: $('#camera-view'), captureCanvas: $('#capture-canvas'),
  pmCapture: $('#pm-capture'), pmRetake: $('#pm-retake'), pmUsePhoto: $('#pm-use-photo'),
  pmBrowse: $('#pm-browse'),
};

let pdfDoc=null, originalBytes=null, filename=null;
let activeTool=null; // 'text'|'stamp'|'sign'|null
let signatureDataURL=null;

const textStyle = { size:16, color:'#000000', bold:false, italic:false, family:'Arial, sans-serif' };

/* ---------- Toast ---------- */
function toast(msg, kind='ok', t=2400){
  refs.toast.textContent = msg; refs.toast.className='';
  refs.toast.classList.add('show', kind); clearTimeout(refs.toast._t);
  refs.toast._t = setTimeout(()=>{ refs.toast.className=''; }, t);
}

/* ---------- Base-metrics Center Zoom ---------- */
const BASE = { w:0, h:0 };
const zoom = {
  scale:1, min:0.6, max:3, suspended:false,
  setScale(newScale, cx, cy){
    newScale = Math.max(this.min, Math.min(this.max, newScale));
    if (newScale === this.scale || BASE.w===0 || BASE.h===0) return;

    const scroll = refs.scroll;
    const rect = scroll.getBoundingClientRect();

    const contentW0 = BASE.w * this.scale;
    const contentH0 = BASE.h * this.scale;
    const contentW1 = BASE.w * newScale;
    const contentH1 = BASE.h * newScale;

    const gx0 = Math.max(0, (scroll.clientWidth  - contentW0)/2);
    const gy0 = Math.max(0, (scroll.clientHeight - contentH0)/2);
    const gx1 = Math.max(0, (scroll.clientWidth  - contentW1)/2);
    const gy1 = Math.max(0, (scroll.clientHeight - contentH1)/2);

    const contentX = (scroll.scrollLeft + (cx - rect.left) - gx0) / this.scale;
    const contentY = (scroll.scrollTop  + (cy - rect.top ) - gy0) / this.scale;

    this.scale = newScale;
    refs.scaler.style.transformOrigin = '0 0';
    refs.scaler.style.transform = `scale(${this.scale})`;

    let newLeft = contentX * this.scale - (cx - rect.left) + gx1;
    let newTop  = contentY * this.scale - (cy - rect.top ) + gy1;

    const maxX = Math.max(0, contentW1 - scroll.clientWidth);
    const maxY = Math.max(0, contentH1 - scroll.clientHeight);
    scroll.scrollLeft = clamp(newLeft, 0, maxX);
    scroll.scrollTop  = clamp(newTop , 0, maxY);

    if (contentW1 <= scroll.clientWidth)  scroll.scrollLeft = 0;
    if (contentH1 <= scroll.clientHeight) scroll.scrollTop  = 0;
  }
};

(function wirePinch(){
  const scroll = refs.scroll;
  const pts = new Map();
  let lastDist=0, cx=0, cy=0, pinching=false;

  const onPD = (e)=>{
    if (zoom.suspended) return;
    pts.set(e.pointerId, e);
    if (pts.size===2){
      const [a,b] = [...pts.values()];
      lastDist = Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY);
      cx = (a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2;
      pinching=true; scroll.style.touchAction='none';
    }
  };
  const onPM = (e)=>{
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e);
    if (pinching && pts.size===2){
      const [a,b] = [...pts.values()];
      const d = Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY);
      cx = (a.clientX+b.clientX)/2; cy=(a.clientY+b.clientY)/2;
      if (lastDist){
        const factor = d/lastDist;
        zoom.setScale(zoom.scale * factor, cx, cy);
      }
      lastDist = d; e.preventDefault();
    }
  };
  const onPU = (e)=>{
    pts.delete(e.pointerId);
    if (pts.size<2){
      pinching=false; lastDist=0; scroll.style.touchAction='pan-y';
    }
  };
  scroll.addEventListener('pointerdown', onPD);
  scroll.addEventListener('pointermove', onPM, {passive:false});
  scroll.addEventListener('pointerup', onPU);
  scroll.addEventListener('pointercancel', onPU);

  // trackpad/ctrl+wheel zoom
  scroll.addEventListener('wheel', (e)=>{
    if (!(e.ctrlKey||e.metaKey)) return;
    e.preventDefault();
    const factor = (e.deltaY<0)?1.1:0.9;
    zoom.setScale(zoom.scale * factor, e.clientX, e.clientY);
  }, {passive:false});

  // block iOS gesture zoom inside stage
  const within = el => !!el && (el===refs.scroll || el===refs.scaler || el===refs.container || el.closest?.('#pdf-stage,#pdf-scroll,#pdf-scaler,#pdf-container'));
  addEventListener('gesturestart',  e=>{ if(within(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gesturechange', e=>{ if(within(e.target)) e.preventDefault(); }, {passive:false});
  addEventListener('gestureend',    e=>{ if(within(e.target)) e.preventDefault(); }, {passive:false});
  refs.scroll.addEventListener('touchmove', (e)=>{ if(e.touches && e.touches.length>1) e.preventDefault(); }, {passive:false});
})();

/* ---------- Render PDF (to canvas 1:1) ---------- */
async function renderPdfFromData(bytes){
  refs.container.innerHTML=''; pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;

  for (let i=1;i<=pdfDoc.numPages;i++){
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale:1 });

    const wrap = document.createElement('div');
    wrap.className='page-wrap'; wrap.dataset.page = String(i-1); wrap.style.position='relative';

    const canvas = document.createElement('canvas');
    canvas.className='pdfpage';
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    canvas.style.width = vp.width+'px'; canvas.style.height = vp.height+'px';
    wrap.appendChild(canvas);

    const overlay = document.createElement('div');
    overlay.className='overlay'; overlay.dataset.pageIndex = String(i-1);
    wrap.appendChild(overlay);

    refs.container.appendChild(wrap);

    const ctx = canvas.getContext('2d', { alpha:false });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
  }

  await new Promise(r=>requestAnimationFrame(r));
  BASE.w = refs.container.scrollWidth;
  BASE.h = refs.container.scrollHeight;

  armOverlays();
  centerHorizontally();
  toast('PDF loaded ✔️');
}

/* ---------- Center helper ---------- */
function centerHorizontally(){
  if (!BASE.w) return;
  const desired = Math.max(0, (BASE.w*zoom.scale - refs.scroll.clientWidth)/2);
  refs.scroll.scrollLeft = desired;
  const totalH = BASE.h*zoom.scale;
  if (totalH <= refs.scroll.clientHeight) refs.scroll.scrollTop = 0;
}
addEventListener('resize', centerHorizontally);

/* ---------- Helpers ---------- */
const clamp = (v, lo, hi)=>Math.max(lo, Math.min(hi, v));
function localXY(overlay, clientX, clientY){
  const r = overlay.getBoundingClientRect();
  return { x: (clientX - r.left) / zoom.scale, y: (clientY - r.top) / zoom.scale };
}
function makeDraggable(el){
  let dragging=false, offX=0, offY=0;
  el.addEventListener('pointerdown', e=>{
    if (e.target.classList.contains('handle')) return;
    dragging=true; el.setPointerCapture?.(e.pointerId);
    offX = e.offsetX; offY = e.offsetY;
  });
  el.addEventListener('pointermove', e=>{
    if (!dragging) return;
    const p = el.parentElement; if (!p) return;
    const pr = p.getBoundingClientRect();
    let nx = (e.clientX - pr.left - offX) / zoom.scale;
    let ny = (e.clientY - pr.top  - offY) / zoom.scale;
    nx = clamp(nx, 0, Math.max(0, p.clientWidth/zoom.scale - el.offsetWidth));
    ny = clamp(ny, 0, Math.max(0, p.clientHeight/zoom.scale - el.offsetHeight));
    el.style.left = nx+'px'; el.style.top = ny+'px';
  });
  el.addEventListener('pointerup', e=>{ dragging=false; el.releasePointerCapture?.(e.pointerId); });
}
function makeResizable(el){
  const h = document.createElement('div'); h.className='handle br'; el.appendChild(h);
  let resizing=false, sx=0, sy=0, sw=0, sh=0;
  h.addEventListener('pointerdown', e=>{
    e.stopPropagation(); resizing=true; h.setPointerCapture?.(e.pointerId);
    sx=e.clientX; sy=e.clientY; sw=el.offsetWidth; sh=el.offsetHeight;
  });
  h.addEventListener('pointermove', e=>{
    if (!resizing) return;
    const dx=(e.clientX - sx) / zoom.scale, dy=(e.clientY - sy) / zoom.scale;
    el.style.width  = Math.max(24, sw + dx) + 'px';
    el.style.height = Math.max(24, sh + dy) + 'px';
  });
  h.addEventListener('pointerup', e=>{ resizing=false; h.releasePointerCapture?.(e.pointerId); });
}

/* ---------- Annotations ---------- */
function addText(overlay, x, y){
  const el=document.createElement('div'); el.className='anno text';
  el.contentEditable='true';
  el.style.left=x+'px'; el.style.top=y+'px';
  el.style.fontSize = `${Math.max(16,textStyle.size)}px`;
  el.style.color = textStyle.color;
  el.style.fontWeight = textStyle.bold ? '700':'400';
  el.style.fontStyle = textStyle.italic ? 'italic':'normal';
  el.style.fontFamily = textStyle.family;
  overlay.appendChild(el); makeDraggable(el);
  el.focus?.({ preventScroll:true });
  const sel=getSelection(), rng=document.createRange();
  rng.selectNodeContents(el); rng.collapse(false); sel.removeAllRanges(); sel.addRange(rng);
}
function addStamp(overlay, x, y){
  const el=document.createElement('div'); el.className='anno stamp';
  el.style.left=x+'px'; el.style.top=y+'px';
  el.innerHTML=`<svg viewBox="0 0 24 24" width="22" height="22"
    style="stroke:#000;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round">
    <polyline points="20 6 9 17 4 12"/></svg>`;
  overlay.appendChild(el); makeDraggable(el);
}
function addImageLike(overlay, x, y, dataURL, kind/* sign|image */){
  const el=document.createElement('div'); el.className=`anno ${kind}`;
  el.style.left=x+'px'; el.style.top=y+'px'; el.style.width='180px'; el.style.height='auto';
  const img=new Image(); img.src=dataURL; img.style.display='block'; img.draggable=false;
  el.appendChild(img); overlay.appendChild(el);
  makeDraggable(el); makeResizable(el);
}

/* ---------- Overlays: dblclick & iOS double‑tap ---------- */
function armOverlays(){
  refs.container.querySelectorAll('.overlay').forEach(ov=>{
    ov.replaceWith(ov.cloneNode(true));
  });
  refs.container.querySelectorAll('.overlay').forEach(ov=>{
    ov.addEventListener('dblclick', e=>{
      const {x,y}=localXY(ov, e.clientX, e.clientY);
      if (activeTool==='text') addText(ov,x,y);
      else if (activeTool==='stamp') addStamp(ov,x,y);
      else if (activeTool==='sign' && signatureDataURL) addImageLike(ov,x,y,signatureDataURL,'sign');
    });

    // iOS double‑tap (suppress browser zoom)
    let lastT=0,lx=0,ly=0;
    ov.addEventListener('pointerdown', e=>{
      if (e.pointerType!=='touch') return;
      e.preventDefault(); // stop Safari page zoom
      const now=performance.now(); const {x,y}=localXY(ov, e.clientX, e.clientY);
      const dbl = (now-lastT<300 && Math.abs(x-lx)<24 && Math.abs(y-ly)<24);
      lastT=now; lx=x; ly=y; if(!dbl) return;
      if (activeTool==='text') addText(ov,x,y);
      else if (activeTool==='stamp') addStamp(ov,x,y);
      else if (activeTool==='sign' && signatureDataURL) addImageLike(ov,x,y,signatureDataURL,'sign');
    }, {passive:false});
  });
}

/* ---------- Signature Modal (canvas) ---------- */
const sig = {
  open(){ refs.sigModal.classList.add('show'); },
  close(){ refs.sigModal.classList.remove('show'); },
  clear(){
    const c=refs.sigPad.getContext('2d');
    c.fillStyle='#fff'; c.fillRect(0,0,refs.sigPad.width,refs.sigPad.height);
    c.lineWidth=2.5; c.strokeStyle='#000'; c.lineCap='round'; c.lineJoin='round';
  },
  init(){
    const c=refs.sigPad.getContext('2d'); this.clear();
    let drawing=false;
    refs.sigPad.addEventListener('pointerdown', e=>{
      drawing=true; refs.sigPad.setPointerCapture?.(e.pointerId);
      c.beginPath(); c.moveTo(e.offsetX,e.offsetY);
    });
    refs.sigPad.addEventListener('pointermove', e=>{
      if(!drawing) return; c.lineTo(e.offsetX,e.offsetY); c.stroke();
      c.beginPath(); c.moveTo(e.offsetX,e.offsetY);
    });
    refs.sigPad.addEventListener('pointerup', e=>{
      drawing=false; refs.sigPad.releasePointerCapture?.(e.pointerId);
    });
    refs.sigUse.addEventListener('click', ()=>{
      signatureDataURL = refs.sigPad.toDataURL('image/png'); // transparent ink over white pad
      this.close(); setActiveTool('sign');
      toast('Signature ready — double‑tap a page to place');
    });
    refs.sigClear.addEventListener('click', ()=> this.clear());
    refs.sigCancel.addEventListener('click', ()=> this.close());
  }
};
sig.init();

/* ---------- Text Settings ---------- */
function showTextPanel(show){ refs.textPanel.style.display = show ? 'block' : 'none'; }
function applyTextPanel(part){
  Object.assign(textStyle, part||{});
  const el = document.activeElement;
  if (el && el.classList?.contains('text')){
    el.style.fontSize = `${Math.max(16,textStyle.size)}px`;
    el.style.color = textStyle.color;
    el.style.fontWeight = textStyle.bold ? '700':'400';
    el.style.fontStyle = textStyle.italic ? 'italic':'normal';
    el.style.fontFamily = textStyle.family;
  }
}
refs.tsSize.addEventListener('input', ()=>{ refs.tsSizeVal.textContent=refs.tsSize.value; applyTextPanel({size:+refs.tsSize.value}); }, {passive:true});
refs.tsColor.addEventListener('input', ()=> applyTextPanel({color:refs.tsColor.value}), {passive:true});
refs.tsBold.addEventListener('change', ()=> applyTextPanel({bold:!!refs.tsBold.checked}));
refs.tsItalic.addEventListener('change', ()=> applyTextPanel({italic:!!refs.tsItalic.checked}));
refs.tsFamily.addEventListener('change', ()=> applyTextPanel({family:refs.tsFamily.value}));

/* ---------- Toolbar ---------- */
function setActiveTool(tool){
  activeTool=tool;
  document.querySelectorAll('#toolbar .btn').forEach(b=>{
    if(['text','stamp','sign'].includes(b.dataset.act)) b.classList.toggle('active', b.dataset.act===tool);
    else b.classList.remove('active');
  });
  showTextPanel(tool==='text');
}
refs.toolbar.addEventListener('click', e=>{
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;

  if (act==='open'){ refs.fileInput.click(); return; }
  if (act==='save'){ saveFlattened(); return; }
  if (act==='help'){ toast('Open a PDF → double‑tap to add Text/Stamp/Signature; Scan/Photo to insert images; Save to flatten.'); return; }
  if (act==='sign'){ sig.open(); return; }
  if (act==='settings'){ showTextPanel(refs.textPanel.style.display==='none'); return; }
  if (act==='scan'){ PhotoModal.open(); return; }

  if (['text','stamp','sign'].includes(act)){
    setActiveTool(activeTool===act ? null : act);
    if (activeTool) toast(activeTool==='text' ? 'Text: double‑tap to place' :
                          activeTool==='stamp' ? 'Stamp: double‑tap to place' :
                          'Signature: double‑tap to place');
  }
});

/* ---------- File open ---------- */
refs.fileInput.addEventListener('change', async e=>{
  const file=e.target.files?.[0]; if(!file) return;
  originalBytes=new Uint8Array(await file.arrayBuffer()); filename=file.name||'document.pdf';
  try{ await renderPdfFromData(originalBytes); }catch(err){ console.error(err); toast('Could not open PDF','err'); }
});

/* ---------- Photo / Scan Modal (camera → canvas) ---------- */
const PhotoModal = (()=> {
  let stream=null;
  const video=refs.cameraView, canvas=refs.captureCanvas, ctx=canvas.getContext('2d');

  function section(which){
    refs.pmCameraSec.classList.toggle('show', which==='camera');
    refs.pmFileSec.classList.toggle('show', which==='file');
  }
  function open(){ refs.pm.classList.add('show'); section('file');
    refs.pmRetake.style.display='none'; refs.pmUsePhoto.style.display='none'; refs.pmCapture.style.display=''; }
  function close(){ refs.pm.classList.remove('show'); stopCamera(); }
  async function startCamera(){
    try{
      stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false });
      video.srcObject = stream; await video.play();
      section('camera'); refs.pmRetake.style.display='none'; refs.pmUsePhoto.style.display='none'; refs.pmCapture.style.display='';
    }catch(e){ console.warn('Camera unavailable', e); toast('Camera unavailable. Choose a photo instead.','err',3200); section('file'); }
  }
  function stopCamera(){ if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; } if(video){ video.pause(); video.srcObject=null; } }
  function capture(){
    const vw = video.videoWidth||1280, vh = video.videoHeight||720;
    canvas.width=vw; canvas.height=vh; ctx.drawImage(video,0,0,vw,vh);
    refs.pmCapture.style.display='none'; refs.pmRetake.style.display=''; refs.pmUsePhoto.style.display='';
  }
  function retake(){ refs.pmCapture.style.display=''; refs.pmRetake.style.display='none'; refs.pmUsePhoto.style.display='none'; }
  function useCaptured(){ place(canvas.toDataURL('image/png')); close(); }
  function choose(){ refs.photoFile.value=''; refs.photoFile.click(); }
  function place(dataURL){
    const page = document.elementFromPoint(innerWidth/2, Math.min(innerHeight/2, refs.scroll.getBoundingClientRect().bottom-10))
                ?.closest?.('.page-wrap') || refs.container.querySelector('.page-wrap');
    const ov = page?.querySelector?.('.overlay'); if(!ov){ toast('Open a PDF first','err'); return; }
    const r = ov.getBoundingClientRect(); const x=(r.width/2)/zoom.scale-90, y=(r.height/2)/zoom.scale-60;
    addImageLike(ov, x, y, dataURL, 'image'); toast('Photo inserted ✔️');
  }

  refs.pmUseCamera.addEventListener('click', startCamera);
  refs.pmChoosePhoto.addEventListener('click', ()=>{ stopCamera(); section('file'); });
  refs.pmClose.addEventListener('click', close);
  refs.pmCapture.addEventListener('click', capture);
  refs.pmRetake.addEventListener('click', retake);
  refs.pmUsePhoto.addEventListener('click', useCaptured);
  refs.pmBrowse.addEventListener('click', ()=> refs.photoFile.click());
  refs.photoFile.addEventListener('change', e=>{
    const f=e.target.files?.[0]; if(!f) return;
    const reader=new FileReader(); reader.onload=()=>{ place(String(reader.result||'')); close(); }; reader.readAsDataURL(f);
  });

  return { open, close };
})();

/* ---------- Save (flatten with pdf-lib) ---------- */
function isValidPdfBytes(bytes){
  if(!bytes||!bytes.length) return false;
  const n=Math.min(bytes.length,16);
  for(let i=0;i<n-4;i++){ if(bytes[i]===0x25&&bytes[i+1]===0x50&&bytes[i+2]===0x44&&bytes[i+3]===0x46&&bytes[i+4]===0x2D) return true; }
  return false;
}
async function saveFlattened(){
  let bytes = originalBytes;
  if(!isValidPdfBytes(bytes)){
    try{ const data = await pdfDoc?.getData?.(); if(data?.length) bytes=new Uint8Array(data); }catch{}
  }
  if(!isValidPdfBytes(bytes)){ toast('Could not read the original PDF. Please reopen the file.','err',3800); return; }

  let PDFDocument, rgb;
  try{ ({PDFDocument, rgb} = await loadPdfLib()); }catch(e){ console.error('pdf-lib load failed', e); toast('Could not load save engine','err'); return; }

  let pdf;
  try{ pdf = await PDFDocument.load(bytes); }catch(e){ console.error('load failed', e); toast('Source PDF is invalid','err'); return; }

  try{
    const pages = pdf.getPages(); const embedOps=[];
    document.querySelectorAll('.page-wrap').forEach((wrap, idx)=>{
      const page = pages[idx]; if(!page) return;
      const canvas = wrap.querySelector('canvas'); const cRect = canvas.getBoundingClientRect();

      wrap.querySelectorAll('.anno').forEach(el=>{
        const r = el.getBoundingClientRect();
        const x = r.left - cRect.left;
        const y = cRect.height - (r.top - cRect.top) - r.height;

        if(el.classList.contains('text')){
          const cs=getComputedStyle(el); const size=parseFloat(cs.fontSize)||16;
          const [rr,gg,bb] = (cs.color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
          page.drawText(el.textContent||'', { x, y, size, color: rgb(rr,gg,bb) });
        } else if(el.classList.contains('stamp')){
          page.drawText('✓', { x, y, size:22, color: rgb(0,0,0) });
        } else {
          const img=el.querySelector('img'); if(!img) return;
          const p=(async()=>{
            let ib;
            if(img.src.startsWith('data:')){ const b64=(img.src.split(',')[1]||''); const bin=atob(b64); ib=new Uint8Array(bin.length); for(let i=0;i<ib.length;i++) ib[i]=bin.charCodeAt(i); }
            else { const res=await fetch(img.src,{mode:'cors'}); ib=new Uint8Array(await res.arrayBuffer()); }
            const png=await pdf.embedPng(ib); page.drawImage(png,{ x, y, width:r.width, height:r.height });
          })(); embedOps.push(p);
        }
      });
    });
    if(embedOps.length) await Promise.all(embedOps);

    const out=await pdf.save();
    const name=(filename||'document.pdf').replace(/\.pdf$/i,'')+'-annotated.pdf';
    const blob=new Blob([out],{type:'application/pdf'}); const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1200); toast('Saved ✔️');
  }catch(e){ console.error('Save failed', e); toast('Could not save PDF','err'); }
}