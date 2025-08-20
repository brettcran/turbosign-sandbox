<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>TurboSign — PDF Annotator (ESM)</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="color-scheme" content="dark light">
  <style>
    :root{
      --bg:#0f131a; --fg:#e9eef5; --panel:rgba(255,255,255,.08); --border:rgba(255,255,255,.14);
      --btn:#141a22; --btn-hov:#1b2330; --icon:#e9eef5; --canvas-bg:#fff;
      --ok:#16a34a; --err:#ef4444; --safe-bottom: env(safe-area-inset-bottom, 0px);
      --accent:#4ea3ff;
    }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{margin:0; font:14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background:var(--bg); color:var(--fg)}

    /* Toolbar */
    #toolbar{
      position:fixed; bottom:calc(12px + var(--safe-bottom)); left:50%; transform:translateX(-50%);
      display:flex; gap:12px; padding:12px; border-radius:18px; z-index:40;
      background:linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,.06));
      border:1px solid var(--border); backdrop-filter:blur(10px);
      max-width:96vw; overflow-x:auto; -webkit-overflow-scrolling:touch; scrollbar-width:none;
      box-shadow:0 10px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.06);
    }
    #toolbar::-webkit-scrollbar{ display:none }
    .btn{
      appearance:none; border:1px solid rgba(255,255,255,.12); background:var(--btn); color:var(--icon);
      width:56px; height:56px; border-radius:14px; display:grid; place-items:center;
      cursor:pointer; transition:background .2s, transform .08s, outline-color .15s, box-shadow .2s; flex:0 0 auto;
      box-shadow:0 2px 8px rgba(0,0,0,.3);
    }
    .btn:hover{ background:var(--btn-hov) }
    .btn:active{ transform:translateY(1px) }
    .btn svg{ width:34px; height:34px; stroke:currentColor; fill:none; stroke-width:2; }
    .btn.active{
      outline:2px solid var(--accent); outline-offset:2px; background:#1b2636;
      box-shadow:0 0 0 1px rgba(78,163,255,.35), 0 8px 20px rgba(78,163,255,.25);
    }
    @media (max-width:420px){
      .btn svg{ width:38px; height:38px }
    }

    /* Stage */
    #pdf-stage{ position:relative; height:100vh; overflow:hidden; background:var(--bg) }
    #pdf-scroll{ position:relative; height:100%; width:100%; overflow:auto; touch-action:pan-y }
    /* The SCALER (scaled) wraps the inner container (measured once for base size) */
    #pdf-scaler{ position:relative; transform-origin:0 0; }
    #pdf-container{
      position:relative;
      display:flex; flex-direction:column; align-items:center; gap:12px;
      padding:20px 0 calc(160px + var(--safe-bottom)); min-height:60vh;
    }
    .page-wrap{ position:relative; width:max(320px,72vw); margin:12px 0 }
    canvas.pdfpage{ display:block; width:100%; height:auto; background:var(--canvas-bg); border-radius:10px; touch-action:none }

    /* Overlays & annotations */
    .overlay{ position:absolute; inset:0; pointer-events:auto; touch-action:manipulation; }
    .anno{ position:absolute; user-select:none; touch-action:none; }
    .anno.selected{ outline:1.5px dashed var(--accent); outline-offset:2px }
    .anno.text{
      min-width:10px; min-height:16px; padding:2px 4px; background:transparent; color:#000;
      font:16px Arial, sans-serif; cursor:text; -webkit-user-select:text; user-select:text;
    }
    .anno.stamp svg{ width:22px; height:22px; stroke:#000; stroke-width:2; fill:none }
    .anno.sign img, .anno.image img{ user-select:none; pointer-events:none; display:block }
    .anno .handle{ position:absolute; width:14px; height:14px; background:#fff; border:2px solid var(--accent); border-radius:3px; }
    .anno .handle.br{ right:-8px; bottom:-8px; cursor:nwse-resize; touch-action:none }

    /* Hidden inputs */
    #file-input,#photo-file{ display:none }

    /* Toast */
    #toast{ position:fixed; top:12px; left:50%; transform:translateX(-50%);
      background:#0b1020d0; color:#eaf2ff; padding:8px 12px; border-radius:10px;
      border:1px solid rgba(255,255,255,.18); z-index:70; font-size:13px; display:none }
    #toast.show{ display:block; animation:fade .2s ease-out }
    #toast.ok{ box-shadow:0 0 0 1px var(--ok) inset } #toast.err{ box-shadow:0 0 0 1px var(--err) inset }
    @keyframes fade{ from{opacity:0; transform:translateX(-50%) translateY(-6px)} to{opacity:1} }

    /* Slide-in Text Settings (no button; auto on Text tool) */
    #text-drawer{
      position:fixed; right:12px; bottom:calc(98px + var(--safe-bottom)); z-index:60;
      background:rgba(18,22,30,.94); border:1px solid rgba(255,255,255,.14); border-radius:12px;
      padding:10px; min-width:248px; color:#e9eef5; font:13px system-ui, sans-serif;
      box-shadow:0 12px 40px rgba(0,0,0,.45);
      transform:translateX(calc(100% + 24px)); opacity:0; pointer-events:none;
      transition:transform .2s ease-out, opacity .2s ease-out;
    }
    #text-drawer.show{ transform:translateX(0); opacity:1; pointer-events:auto; }
    #text-drawer .row{ display:flex; gap:8px; align-items:center; margin:8px 0; }
    #text-drawer input[type="range"]{ width:150px }

    /* Photo / Scan Modal */
    .modal{
      position:fixed; inset:50% auto auto 50%; transform:translate(-50%,-50%);
      z-index:60; background:rgba(18,22,30,.96); color:#e9eef5;
      border:1px solid rgba(255,255,255,.14); border-radius:14px; padding:14px;
      width:min(94vw,560px); box-shadow:0 16px 48px rgba(0,0,0,.55);
      display:block; opacity:0; pointer-events:none; transition:opacity .15s ease-out;
    }
    .modal.show{ opacity:1; pointer-events:auto; }
    .modal h3{ margin:6px 0 10px; font:600 16px system-ui }
    .modal .row{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px }
    .chip{ appearance:none; border:1px solid rgba(255,255,255,.14); background:#1c2430; color:#e9eef5;
      border-radius:10px; padding:8px 10px; cursor:pointer }

    #photo-modal .section{ display:none; margin-top:8px }
    #photo-modal .section.show{ display:block }
    #camera-view{ width:100%; max-height:50vh; border-radius:10px; background:#000; }
    #capture-canvas{ display:none }

    /* Safari tap/zoom behavior */
    #pdf-stage, #pdf-scroll, #pdf-scaler, #pdf-container, #toolbar, .btn, .overlay { touch-action:manipulation; }
    .anno.text, input, button, select, textarea { font-size:16px; }
  </style>

  <!-- iOS: disable browser zoom (app handles pinch inside stage) -->
  <script>
    (function lockIOSPageZoom(){
      const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (!iOS) return;
      let meta = document.querySelector('meta[name=viewport]');
      if (!meta) { meta = document.createElement('meta'); meta.name='viewport'; document.head.appendChild(meta); }
      meta.setAttribute('content','width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    })();
  </script>
</head>
<body>
  <!-- Hidden inputs -->
  <input id="file-input" type="file" accept="application/pdf,.pdf" />
  <input id="photo-file" type="file" accept="image/*" />

  <!-- Toolbar -->
  <div id="toolbar" aria-label="Tools">
    <button class="btn" data-act="open" title="Open PDF" aria-label="Open PDF">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h8l4 4v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M12 3v6H6"/></svg>
    </button>
    <button class="btn" data-act="text" title="Text (double‑tap/click)" aria-label="Text">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M10 6v12m4-12v12" /></svg>
    </button>
    <button class="btn" data-act="stamp" title="Stamp (✓)" aria-label="Stamp">
      <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
    </button>
    <button class="btn" data-act="sign" title="Signature" aria-label="Signature">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16c3-2 4 2 6 2s3-4 5-4 2 4 5 4M3 20h18" /></svg>
    </button>
    <button class="btn" data-act="scan" title="Insert Photo / Scan" aria-label="Insert Photo / Scan">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="8" width="10" height="8" rx="2" ry="2"/><path d="M3 5h4M17 5h4M3 19h4M17 19h4"/></svg>
    </button>
    <button class="btn" data-act="undo" title="Undo" aria-label="Undo">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l-4 4 4 4"/><path d="M3 11h10a5 5 0 1 1 0 10h-2"/></svg>
    </button>
    <button class="btn" data-act="redo" title="Redo" aria-label="Redo">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 7l4 4-4 4"/><path d="M21 11H11a5 5 0 1 0 0 10h2"/></svg>
    </button>
    <button class="btn" data-act="save" title="Save (flatten to PDF)" aria-label="Save">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7a2 2 0 0 1 2-2h7l5 5v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M8 21v-6h8v6"/></svg>
    </button>
    <button class="btn" data-act="help" title="Help" aria-label="Help">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17h.01M9.09 9a3 3 0 1 1 5.82 1c0 1.5-1.5 2-2 3"/><circle cx="12" cy="12" r="9"/></svg>
    </button>
  </div>

  <!-- Stage -->
  <div id="pdf-stage">
    <div id="pdf-scroll">
      <div id="pdf-scaler">
        <div id="pdf-container"></div>
      </div>
    </div>
  </div>

  <!-- Slide‑in Text Drawer -->
  <div id="text-drawer" aria-label="Text Settings">
    <div class="row">
      <label>Size <input id="ts-size" type="range" min="16" max="48" step="1" value="16" /> <span id="ts-size-val">16</span></label>
    </div>
    <div class="row">
      <label>Color <input id="ts-color" type="color" value="#000000" /></label>
      <label>Bold <input id="ts-bold" type="checkbox" /></label>
      <label>Italic <input id="ts-italic" type="checkbox" /></label>
    </div>
    <div class="row">
      <label>Font
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
  </div>

  <!-- Toast -->
  <div id="toast" role="status" aria-live="polite"></div>

  <!-- Signature Modal -->
  <div id="sign-modal" class="modal" role="dialog" aria-modal="true" aria-label="Signature">
    <h3>Draw your signature</h3>
    <canvas id="sig-pad" width="500" height="200"
      style="display:block;max-width:100%;height:auto;background:#fff;border-radius:10px;touch-action:none"></canvas>
    <div class="row">
      <button class="chip" id="sig-use">Use</button>
      <button class="chip" id="sig-clear">Clear</button>
      <button class="chip" id="sig-cancel">Cancel</button>
    </div>
  </div>

  <!-- Photo / Scan Modal -->
  <div id="photo-modal" class="modal" role="dialog" aria-modal="true" aria-label="Insert Photo or Scan">
    <h3>Insert Photo / Scan</h3>
    <div class="row">
      <button class="chip" id="pm-use-camera">Use Camera</button>
      <button class="chip" id="pm-choose-photo">Choose Photo</button>
      <button class="chip" id="pm-close">Close</button>
    </div>
    <div id="pm-camera" class="section">
      <video id="camera-view" playsinline autoplay muted></video>
      <canvas id="capture-canvas" width="1280" height="720"></canvas>
      <div class="row">
        <button class="chip" id="pm-capture">Capture</button>
        <button class="chip" id="pm-retake"  style="display:none;">Retake</button>
        <button class="chip" id="pm-use-photo" style="display:none;">Use Photo</button>
      </div>
    </div>
    <div id="pm-file" class="section">
      <p style="opacity:.8">Select an image from your device.</p>
      <div class="row"><button class="chip" id="pm-browse">Browse…</button></div>
    </div>
  </div>

  <!-- App (ESM) -->
  <script type="module" src="./lib/app/app.mjs"></script>
</body>
</html>