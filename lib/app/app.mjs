// TurboSign v4.1 — Insert Photo Support
// -------------------------------------------------
// Core: PDF loading, annotation, signatures, stamps
// New: Insert Photo as draggable/resizable annotation

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.mjs";
import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.54/build/pdf.worker.min.js";

// -------------------------------------------------
// Globals
let pdfDoc = null;
let currentScale = 1.0;
let annotations = [];
let currentTool = null;
let sigImage = null;

// Hidden file input for photo uploads
const photoInput = document.createElement("input");
photoInput.type = "file";
photoInput.accept = "image/*";
photoInput.style.display = "none";
document.body.appendChild(photoInput);

// -------------------------------------------------
// PDF Loading
const container = document.getElementById("pdf-container");
const fileInput = document.getElementById("file-input");

fileInput.addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const data = await file.arrayBuffer();
  renderPdfFromData(data);
});

async function renderPdfFromData(data) {
  pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  container.innerHTML = "";
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: currentScale });

    const wrapper = document.createElement("div");
    wrapper.className = "page-wrap";

    const canvas = document.createElement("canvas");
    canvas.className = "pdfpage";
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    wrapper.appendChild(canvas);

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    wrapper.appendChild(overlay);

    container.appendChild(wrapper);

    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
  }
}

// -------------------------------------------------
// Toolbar Actions
document.getElementById("toolbar").addEventListener("click", e => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  if (act === "open") {
    fileInput.click();
  } else if (act === "text" || act === "stamp" || act === "sign" || act === "photo") {
    currentTool = act;
    if (act === "photo") {
      photoInput.click();
    }
  } else if (act === "save") {
    saveFlattened();
  }
});

// -------------------------------------------------
// Insert Photo
photoInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = document.createElement("img");
    img.src = ev.target.result;
    img.style.maxWidth = "150px";
    img.style.maxHeight = "150px";

    const anno = document.createElement("div");
    anno.className = "anno photo";
    anno.style.left = "50px";
    anno.style.top = "50px";
    anno.appendChild(img);

    makeDraggable(anno);
    const overlay = container.querySelector(".overlay");
    overlay.appendChild(anno);

    annotations.push({ type: "photo", imgData: ev.target.result, anno, page: 1 });
  };
  reader.readAsDataURL(file);
});

// -------------------------------------------------
// Draggable Utility
function makeDraggable(el) {
  let offsetX = 0, offsetY = 0, isDown = false;
  el.addEventListener("mousedown", e => {
    isDown = true;
    offsetX = e.offsetX;
    offsetY = e.offsetY;
  });
  document.addEventListener("mouseup", () => (isDown = false));
  document.addEventListener("mousemove", e => {
    if (!isDown) return;
    el.style.left = e.pageX - offsetX + "px";
    el.style.top = e.pageY - offsetY + "px";
  });
}

// -------------------------------------------------
// Save / Flatten
async function saveFlattened() {
  if (!pdfDoc) return alert("No PDF open");

  const data = await fetch(pdfDoc._pdfInfo.url).then(r => r.arrayBuffer());
  const pdfDocLib = await PDFDocument.load(data);

  for (const a of annotations) {
    if (a.type === "photo") {
      const page = pdfDocLib.getPages()[a.page - 1];
      const pngBytes = await fetch(a.imgData).then(r => r.arrayBuffer());
      const img = await pdfDocLib.embedPng(pngBytes);

      const rect = a.anno.getBoundingClientRect();
      const { width, height } = img.scale(0.5);
      page.drawImage(img, {
        x: rect.left,
        y: rect.top,
        width,
        height
      });
    }
  }

  const pdfBytes = await pdfDocLib.save();
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "annotated.pdf";
  a.click();
  URL.revokeObjectURL(url);
}
