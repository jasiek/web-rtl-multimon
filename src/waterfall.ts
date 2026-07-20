// Scrolling waterfall display with click-to-tune, mouse-wheel zoom and
// middle-button drag-to-pan.
//
// Two stacked canvases share a wrapper:
//   • the spectrogram canvas scrolls down one row per FFT column;
//   • a transparent overlay canvas on top carries the channel marker, the
//     channel-width band, the frequency axis and the zoom readout — redrawn on
//     demand so they don't scroll away with the spectrogram.
//
// A ring of recent magnitude columns is kept so that zooming/panning can
// re-render the whole visible history at the new mapping (not just new rows).
//
// The x axis maps a *fraction* f ∈ [0,1] of the full tuned span to a frequency
// (f=0 → centerHz − sampleRate/2, f=1 → centerHz + sampleRate/2). The visible
// window is a sub-range of that fraction determined by `zoom` (≥1) and the view
// center; a click sets the channel offset and fires onTune(offsetHz).

/** Map a normalized value 0..1 to an inferno-ish [r,g,b]. */
function colormap(t: number): [number, number, number] {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  const stops: [number, number, number, number][] = [
    [0.0, 0, 0, 4],
    [0.35, 90, 20, 110],
    [0.7, 220, 90, 40],
    [1.0, 250, 250, 200],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [x0, r0, g0, b0] = stops[i - 1];
      const [x1, r1, g1, b1] = stops[i];
      const f = (x - x0) / (x1 - x0 || 1);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [250, 250, 200];
}

const DYN_RANGE_DB = 55; // color span above the tracked noise floor
const MAX_ZOOM = 128;
const WHEEL_STEP = 1.25;
const BG: [number, number, number] = [5, 6, 10];

export class Waterfall {
  private readonly wf: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly wfCtx: CanvasRenderingContext2D;
  private readonly ovCtx: CanvasRenderingContext2D;
  private row!: ImageData;

  private width = 0;
  private height = 0;
  private sampleRate = 1;
  private centerHz = 0;
  private offsetHz = 0;
  private bandwidthHz = 12_500;
  private noiseFloor = -60; // adaptive, dB

  // Recent magnitude columns, newest first (cols[0] is the top row).
  private cols: Float32Array[] = [];

  // View: `zoom` ≥ 1 shrinks the visible span to 1/zoom of the full span;
  // `centerFrac` ∈ [0,1] is the fraction at the middle of the view.
  private zoom = 1;
  private centerFrac = 0.5;

  // Middle-button pan state.
  private panning = false;
  private panStartX = 0;
  private panStartCenter = 0.5;

  private renderScheduled = false;

  onTune: ((offsetHz: number) => void) | undefined;

  constructor(wrapper: HTMLElement) {
    this.wf = document.createElement("canvas");
    this.overlay = document.createElement("canvas");
    for (const c of [this.wf, this.overlay]) {
      c.style.position = "absolute";
      c.style.inset = "0";
      c.style.width = "100%";
      c.style.height = "100%";
      wrapper.appendChild(c);
    }
    this.overlay.style.cursor = "crosshair";
    this.overlay.style.touchAction = "none";
    this.wfCtx = this.wf.getContext("2d", { alpha: false })!;
    this.ovCtx = this.overlay.getContext("2d")!;

    this.overlay.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.overlay.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.overlay.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.overlay.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    this.overlay.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // Suppress the browser's middle-click autoscroll / paste.
    this.overlay.addEventListener("auxclick", (e) => e.preventDefault());

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(wrapper);
    this.resize();
  }

  private resize(): void {
    const rect = this.wf.parentElement!.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    for (const c of [this.wf, this.overlay]) {
      c.width = w;
      c.height = h;
    }
    if (this.cols.length > h) this.cols.length = h;
    this.row = this.wfCtx.createImageData(w, 1);
    this.renderAll();
    this.drawOverlay();
  }

  setChannel(centerHz: number, sampleRate: number): void {
    this.centerHz = centerHz;
    this.sampleRate = sampleRate;
    this.drawOverlay();
  }

  setOffset(offsetHz: number): void {
    this.offsetHz = offsetHz;
    this.drawOverlay();
  }

  setBandwidth(hz: number): void {
    this.bandwidthHz = hz;
    this.drawOverlay();
  }

  // --- view geometry ---------------------------------------------------------
  private viewWidth(): number {
    return 1 / this.zoom;
  }

  /** Clamp the view center so the window stays within [0,1]. */
  private clampCenter(c: number): number {
    const half = this.viewWidth() / 2;
    return Math.min(1 - half, Math.max(half, c));
  }

  private viewLo(): number {
    return this.centerFrac - this.viewWidth() / 2;
  }

  private fractionForX(x: number): number {
    return this.viewLo() + (x / this.width) * this.viewWidth();
  }

  private xForFraction(f: number): number {
    return ((f - this.viewLo()) / this.viewWidth()) * this.width;
  }

  private freqForFraction(f: number): number {
    return this.centerHz + (f - 0.5) * this.sampleRate;
  }

  // --- data ------------------------------------------------------------------
  /** Push one FFT column (dB magnitudes, DC-centered) as the new top row. */
  pushColumn(mags: Float32Array): void {
    const w = this.width;
    const h = this.height;
    if (w < 1 || h < 1) return;

    // Track the noise floor from this column's minimum (fast attack, slow
    // release) so the color scale follows the actual signal level.
    let min = Infinity;
    for (let i = 0; i < mags.length; i++) if (mags[i] < min) min = mags[i];
    if (Number.isFinite(min)) {
      this.noiseFloor = min < this.noiseFloor ? min : this.noiseFloor * 0.98 + min * 0.02;
    }

    // Keep a copy for re-rendering on zoom/pan.
    this.cols.unshift(mags.slice());
    if (this.cols.length > h) this.cols.pop();

    // Fast path: scroll down one pixel and stamp the new row at the top.
    this.fillRow(this.row.data, mags);
    this.wfCtx.drawImage(this.wf, 0, 0, w, h - 1, 0, 1, w, h - 1);
    this.wfCtx.putImageData(this.row, 0, 0);
  }

  /** Render one row of pixels (width = canvas width) from a magnitude column. */
  private fillRow(data: Uint8ClampedArray, mags: Float32Array): void {
    const w = this.width;
    const n = mags.length;
    const floor = this.noiseFloor;
    for (let x = 0; x < w; x++) {
      const f = this.fractionForX(x);
      let bin = (f * n) | 0;
      if (bin < 0) bin = 0;
      else if (bin >= n) bin = n - 1;
      const [r, g, b] = colormap((mags[bin] - floor) / DYN_RANGE_DB);
      const o = x * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }

  /** Redraw the whole spectrogram from the column history at the current view. */
  private renderAll(): void {
    const w = this.width;
    const h = this.height;
    if (w < 1 || h < 1) return;
    const img = this.wfCtx.createImageData(w, h);
    const data = img.data;
    // Background for rows with no data yet.
    for (let i = 0; i < data.length; i += 4) {
      data[i] = BG[0];
      data[i + 1] = BG[1];
      data[i + 2] = BG[2];
      data[i + 3] = 255;
    }
    const rows = Math.min(this.cols.length, h);
    for (let y = 0; y < rows; y++) {
      this.fillRow(data.subarray(y * w * 4, (y + 1) * w * 4), this.cols[y]);
    }
    this.wfCtx.putImageData(img, 0, 0);
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.renderAll();
      this.drawOverlay();
    });
  }

  // --- overlay ---------------------------------------------------------------
  private drawOverlay(): void {
    const ctx = this.ovCtx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

    // Channel-width band + center marker.
    const cx = this.xForFraction(0.5 + this.offsetHz / this.sampleRate);
    const bandPx = (this.bandwidthHz / this.sampleRate) * this.zoom * w;
    ctx.fillStyle = "rgba(74, 222, 128, 0.15)";
    ctx.fillRect(cx - bandPx / 2, 0, bandPx, h);
    ctx.strokeStyle = "rgba(74, 222, 128, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();

    // Frequency axis across the *visible* range.
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "top";
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const x = (i / ticks) * w;
      const hz = this.freqForFraction(this.fractionForX(x));
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 6);
      ctx.stroke();
      const label = (hz / 1e6).toFixed(this.zoom >= 8 ? 4 : 3);
      const tw = ctx.measureText(label).width;
      const lx = Math.max(2, Math.min(w - tw - 2, x - tw / 2));
      ctx.fillStyle = "rgba(230, 232, 236, 0.85)";
      ctx.fillText(label, lx, 8);
    }

    // Selected-frequency readout near the marker.
    const selHz = this.centerHz + this.offsetHz;
    const sel = `${(selHz / 1e6).toFixed(4)} MHz`;
    ctx.fillStyle = "rgba(74, 222, 128, 1)";
    const sw = ctx.measureText(sel).width;
    const sx = cx + 6 + sw > w - 2 ? cx - sw - 6 : cx + 6;
    ctx.fillText(sel, Math.max(2, sx), h - 18);

    // Zoom / visible-span readout (top-right).
    if (this.zoom > 1.001) {
      const spanKHz = (this.sampleRate / this.zoom) / 1e3;
      const z = `${this.zoom.toFixed(1)}× · ${spanKHz.toFixed(spanKHz < 100 ? 1 : 0)} kHz`;
      ctx.fillStyle = "rgba(230, 232, 236, 0.7)";
      const zw = ctx.measureText(z).width;
      ctx.fillText(z, w - zw - 6, 8);
    }
  }

  // --- interaction -----------------------------------------------------------
  private localX(e: PointerEvent | WheelEvent): number {
    return e.clientX - this.overlay.getBoundingClientRect().left;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const x = this.localX(e);
    const fCursor = this.fractionForX(x);
    const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, this.zoom * factor));
    // Keep the frequency under the cursor pinned to the same pixel.
    this.centerFrac = this.clampCenter(fCursor - this.viewWidth() * (x / this.width - 0.5));
    this.scheduleRender();
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 1) {
      // Middle button: start panning.
      e.preventDefault();
      this.panning = true;
      this.panStartX = this.localX(e);
      this.panStartCenter = this.centerFrac;
      this.overlay.setPointerCapture(e.pointerId);
      this.overlay.style.cursor = "grabbing";
    } else if (e.button === 0) {
      // Left button: tune the decode channel.
      const offset = (this.fractionForX(this.localX(e)) - 0.5) * this.sampleRate;
      this.setOffset(offset);
      this.onTune?.(offset);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.panning) return;
    const dx = this.localX(e) - this.panStartX;
    const deltaFrac = -(dx / this.width) * this.viewWidth();
    this.centerFrac = this.clampCenter(this.panStartCenter + deltaFrac);
    this.scheduleRender();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.panning) return;
    this.panning = false;
    this.overlay.releasePointerCapture?.(e.pointerId);
    this.overlay.style.cursor = "crosshair";
  }
}
