// Scrolling waterfall display with click-to-tune.
//
// Two stacked canvases share a wrapper:
//   • the spectrogram canvas scrolls down one row per FFT column;
//   • a transparent overlay canvas on top carries the channel marker, the
//     channel-width band, and the frequency axis — redrawn on demand so they
//     don't scroll away with the spectrogram.
//
// The x axis maps linearly across the tuned span: the left edge is
// centerHz − sampleRate/2, the middle is centerHz, the right edge is
// centerHz + sampleRate/2. A click sets the channel offset from center and
// fires onTune(offsetHz).

/** Map a normalized value 0..1 to an inferno-ish [r,g,b]. */
function colormap(t: number): [number, number, number] {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  // Cheap 4-stop ramp: black -> purple -> orange -> yellow-white.
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
    this.wfCtx = this.wf.getContext("2d", { alpha: false })!;
    this.ovCtx = this.overlay.getContext("2d")!;

    this.overlay.addEventListener("pointerdown", (e) => this.onClick(e));
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(wrapper);
    this.resize();
  }

  private resize(): void {
    const rect = this.wf.parentElement!.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w === this.width && h === this.height) return;
    // Preserve existing spectrogram content across a resize.
    const prev = this.width && this.height ? this.wfCtx.getImageData(0, 0, this.width, this.height) : null;
    this.width = w;
    this.height = h;
    for (const c of [this.wf, this.overlay]) {
      c.width = w;
      c.height = h;
    }
    this.wfCtx.fillStyle = "#05060a";
    this.wfCtx.fillRect(0, 0, w, h);
    if (prev) this.wfCtx.putImageData(prev, 0, 0);
    this.row = this.wfCtx.createImageData(w, 1);
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

  /** Push one FFT column (dB magnitudes, DC-centered) as the new top row. */
  pushColumn(mags: Float32Array): void {
    const w = this.width;
    const h = this.height;
    if (w < 1 || h < 1) return;

    // Track the noise floor from this column's minimum (fast attack up on quiet,
    // slow release), so the color scale follows the actual signal level.
    let min = Infinity;
    for (let i = 0; i < mags.length; i++) if (mags[i] < min) min = mags[i];
    if (Number.isFinite(min)) {
      this.noiseFloor = min < this.noiseFloor ? min : this.noiseFloor * 0.98 + min * 0.02;
    }
    const floor = this.noiseFloor;

    // Build the new row: each pixel samples the FFT bin it maps to.
    const data = this.row.data;
    const n = mags.length;
    for (let x = 0; x < w; x++) {
      const bin = ((x / w) * n) | 0;
      const norm = (mags[bin] - floor) / DYN_RANGE_DB;
      const [r, g, b] = colormap(norm);
      const o = x * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }

    // Scroll the spectrogram down one pixel, then stamp the new row on top.
    this.wfCtx.drawImage(this.wf, 0, 0, w, h - 1, 0, 1, w, h - 1);
    this.wfCtx.putImageData(this.row, 0, 0);
  }

  private xForOffset(offsetHz: number): number {
    return this.width * (0.5 + offsetHz / this.sampleRate);
  }

  private offsetForX(x: number): number {
    return (x / this.width - 0.5) * this.sampleRate;
  }

  private drawOverlay(): void {
    const ctx = this.ovCtx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

    // Channel-width band.
    const bandPx = (this.bandwidthHz / this.sampleRate) * w;
    const cx = this.xForOffset(this.offsetHz);
    ctx.fillStyle = "rgba(74, 222, 128, 0.15)";
    ctx.fillRect(cx - bandPx / 2, 0, bandPx, h);
    // Center marker.
    ctx.strokeStyle = "rgba(74, 222, 128, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();

    // Frequency axis (a few ticks across the span).
    ctx.fillStyle = "rgba(230, 232, 236, 0.85)";
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "top";
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const x = frac * w;
      const hz = this.centerHz + (frac - 0.5) * this.sampleRate;
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 6);
      ctx.stroke();
      const label = (hz / 1e6).toFixed(3);
      const tw = ctx.measureText(label).width;
      let lx = x - tw / 2;
      lx = Math.max(2, Math.min(w - tw - 2, lx));
      ctx.fillText(label, lx, 8);
    }

    // Selected-frequency readout near the marker.
    const selHz = this.centerHz + this.offsetHz;
    const sel = `${(selHz / 1e6).toFixed(4)} MHz`;
    ctx.fillStyle = "rgba(74, 222, 128, 1)";
    const sw = ctx.measureText(sel).width;
    let sx = cx + 6;
    if (sx + sw > w - 2) sx = cx - sw - 6;
    ctx.fillText(sel, sx, h - 18);
  }

  private onClick(e: PointerEvent): void {
    const rect = this.overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const offset = this.offsetForX(x);
    this.setOffset(offset);
    this.onTune?.(offset);
  }
}
