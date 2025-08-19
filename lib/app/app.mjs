// ===== 3) Zoom manager (pinch + wheel + slider; NO double‑tap) =====
class Zoom {
  constructor(container, scrollElem){
    this.container = container;
    this.scroll = scrollElem;
    this.scale = 1;
    this.min = 0.6;
    this.max = 3;
    this._pinching = false;
    this._lastDist = 0;
    this._cx = 0; this._cy = 0; // gesture focus in client coords
    this.container.style.transformOrigin = '0 0';

    // Wheel zoom (Ctrl/⌘ + wheel to avoid accidental scroll fights)
    on(scrollElem, 'wheel', (e)=>this._onWheel(e), { passive:false });

    // Pinch zoom via two pointers
    on(scrollElem, 'pointerdown', (e)=>this._onPointerDown(e));
    on(scrollElem, 'pointermove', (e)=>this._onPointerMove(e));
    on(scrollElem, 'pointerup',   (e)=>this._onPointerUp(e));
    on(scrollElem, 'pointercancel',(e)=>this._onPointerUp(e));
    this._pts = new Map();
  }

  fitToWidth(){
    const first = this.container.querySelector('.page-wrap');
    if (!first) return;
    const stageW = this.scroll.clientWidth - 24; // a bit of gutter
    // current rendered width in CSS px (with current scale)
    const currentCSSWidth = first.getBoundingClientRect().width;
    // compute the scale that would fit the current first page to stage width
    const factor = stageW / currentCSSWidth;
    const target = Math.max(this.min, Math.min(this.max, this.scale * factor));
    // focus roughly at center of viewport
    const cx = this.scroll.clientWidth / 2, cy = this.scroll.clientHeight / 2;
    this.setScale(target, cx, cy, true);
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
      this.scroll.scrollLeft = nx;
      this.scroll.scrollTop  = ny;
    }

    // sync slider if present
    const slider = $('#zoom-slider'), zval = $('#zoom-val');
    if (slider){ slider.value = String(Math.round(this.scale * 100)); }
    if (zval){ zval.textContent = `${Math.round(this.scale * 100)}%`; }
  }

  _onWheel(e){
    if (!(e.ctrlKey || e.metaKey)) return;
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
      // while pinching, allow two-finger pan via native scroll; no extra work needed
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
}

// … existing code …

// After you instantiate zoom (you already have):
//   const zoom = new Zoom(refs.container, refs.scroll);
// keep that line as is.

// ===== UI Wiring for the zoom HUD =====
const zMinus = document.querySelector('#zoom-hud .zminus');
const zPlus  = document.querySelector('#zoom-hud .zplus');
const zFit   = document.querySelector('#zoom-fit');
const zSlider= document.querySelector('#zoom-slider');

on(zMinus, 'click', () => {
  const cx = refs.scroll.clientWidth/2, cy = refs.scroll.clientHeight/2;
  zoom.setScale(zoom.scale * 0.9, cx, cy, true);
});
on(zPlus,  'click', () => {
  const cx = refs.scroll.clientWidth/2, cy = refs.scroll.clientHeight/2;
  zoom.setScale(zoom.scale * 1.1, cx, cy, true);
});
on(zFit, 'click', () => zoom.fitToWidth());
on(zSlider, 'input', (e) => {
  const val = (+e.target.value) / 100;
  const cx = refs.scroll.clientWidth/2, cy = refs.scroll.clientHeight/2;
  zoom.setScale(val, cx, cy, true);
});
