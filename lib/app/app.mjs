// --- helpers to load pdf-lib robustly ---
function loadScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
async function loadPdfLib(){
  // 1) ESM on CDN (fast path)
  try {
    return await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm');
  } catch (e) {
    console.warn('pdf-lib ESM CDN failed, trying local UMD…', e);
  }
  // 2) Local UMD (global PDFLib) — works with your lib/pdf-lib.min.js
  try {
    // prevent double-inject
    if (!window.PDFLib) {
      await loadScript(new URL('../pdf-lib.min.js', import.meta.url).href);
    }
    if (window.PDFLib) return window.PDFLib;
  } catch (e) {
    console.error('Local UMD load failed', e);
  }
  throw new Error('Unable to load pdf-lib');
}

// --- SAVE: uses loader above; preserves transparent signatures ---
async function saveFlattened(){
  if(!CURRENT_PDF.bytes){ toast('Open a PDF first','err'); return; }

  let PDFDocument, rgb, StandardFonts;
  try {
    ({ PDFDocument, rgb, StandardFonts } = await loadPdfLib());
  } catch (e) {
    console.error(e);
    toast('Could not load save engine', 'err');
    return;
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

        if (el.classList.contains('text')) {
          const cs = getComputedStyle(el);
          const size = (parseFloat(cs.fontSize)||16) * fx;
          const [r,g,b] = (cs.color.match(/\d+/g)||[0,0,0]).map(n=>parseInt(n,10)/255);
          const font = (parseInt(cs.fontWeight,10)||400) >= 600 ? helvB : helv;
          page.drawText(el.textContent||'', { x, y, size, font, color: rgb(r,g,b) });
        }
        else if (el.classList.contains('stamp')) {
          const stroke = rgb(0,0,0);
          const x1=x, y1=y+h*fy*0.45, x2=x+w*fx*0.35, y2=y+h*fy*0.15, x3=x+w*fx, y3=y+h*fy*0.85;
          page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:2*fx, color:stroke });
          page.drawLine({ start:{x:x2,y:y2}, end:{x:x3,y:y3}, thickness:2*fx, color:stroke });
        }
        else { // signature (PNG with alpha)
          const img = el.querySelector('img'); if(!img) return;
          const p = (async ()=>{
            try{
              let bytes;
              if (img.src.startsWith('data:')) {
                const b64 = (img.src.split(',')[1]||'');
                const bin = atob(b64);
                bytes = new Uint8Array(bin.length);
                for (let i=0;i<bytes.length;i++) bytes[i] = bin.charCodeAt(i);
              } else {
                const res = await fetch(img.src, { mode:'cors' });
                bytes = new Uint8Array(await res.arrayBuffer());
              }
              const png = await pdf.embedPng(bytes);
              page.drawImage(png, { x, y, width:w*fx, height:h*fy });
            } catch (e) {
              console.warn('Signature PNG embed failed:', e);
            }
          })();
          embedOps.push(p);
        }
      });
    });

    if (embedOps.length) await Promise.all(embedOps);

    const out = await pdf.save();
    const defaultName = (CURRENT_PDF.filename||'document.pdf').replace(/\.pdf$/i,'') + '-signed.pdf';

    if ('showSaveFilePicker' in window) {
      try{
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types:[{ description:'PDF', accept:{ 'application/pdf':['.pdf'] } }]
        });
        const w = await handle.createWritable(); await w.write(out); await w.close();
        toast('Saved ✔️'); return;
      }catch{/* fallback below */}
    }

    // fallback: download
    const blob = new Blob([out], { type:'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = defaultName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1200);
    toast('Downloaded ✔️');
  }catch(e){
    console.error('Save failed:', e);
    toast('Could not save PDF', 'err');
  }
}
