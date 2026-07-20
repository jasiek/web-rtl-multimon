// A small, allocation-free radix-2 FFT plus a spectrum helper for the waterfall.
//
// The waterfall shows the whole tuned span, so we FFT the raw complex IQ (cu8)
// directly -- one column per block. cu8 is unsigned 8-bit centered on 127.4;
// we convert to float in [-1, 1), apply a Hann window to tame spectral leakage,
// transform, then output magnitude in dB with DC shifted to the centre bin so
// the array maps left->right as [center - Fs/2 .. center + Fs/2].

export class Fft {
  private readonly n: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint32Array;
  private readonly window: Float32Array;
  // Scratch buffers reused across calls (one column of spectrum at a time).
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly out: Float32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.n = size;
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
    this.out = new Float32Array(size);

    // Precompute twiddle factors for every stage (indexed by butterfly step).
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }

    // Bit-reversal permutation table.
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }

    // Hann window.
    this.window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    }
  }

  /**
   * Compute a windowed power spectrum (dB, DC-centred) from the newest samples
   * of a cu8 IQ block. Reads the last `n` complex samples (2 bytes each) so a
   * large block still yields one representative column. Returns an internal
   * buffer -- copy it (or transfer a slice) before the next call.
   */
  spectrumFromCu8(cu8: Uint8Array): Float32Array {
    const n = this.n;
    const complexAvail = cu8.length >> 1;
    const start = Math.max(0, complexAvail - n) * 2; // byte offset of the tail window
    const count = Math.min(n, complexAvail);

    const re = this.re;
    const im = this.im;
    for (let i = 0; i < count; i++) {
      const w = this.window[i];
      re[i] = ((cu8[start + 2 * i] - 127.4) / 128) * w;
      im[i] = ((cu8[start + 2 * i + 1] - 127.4) / 128) * w;
    }
    // Zero-pad if the block was shorter than the FFT (rare; small blocks).
    for (let i = count; i < n; i++) {
      re[i] = 0;
      im[i] = 0;
    }

    this.transform(re, im);

    // Magnitude -> dB, with an fftshift so bin 0 (DC) lands in the middle.
    const out = this.out;
    const half = n >> 1;
    const norm = 1 / n;
    for (let i = 0; i < n; i++) {
      const power = (re[i] * re[i] + im[i] * im[i]) * norm * norm;
      const db = 10 * Math.log10(power + 1e-12);
      // Shift: source bin i -> display index (i + half) mod n.
      out[(i + half) % n] = db;
    }
    return out;
  }

  /** In-place complex FFT on (re, im), both length n. */
  private transform(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    const rev = this.rev;

    // Reorder by bit-reversed index.
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    // Iterative Cooley-Tukey butterflies.
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        let k = 0;
        for (let j = i; j < i + half; j++) {
          const c = this.cos[k];
          const s = this.sin[k];
          const tr = re[j + half] * c - im[j + half] * s;
          const ti = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tr;
          im[j + half] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
          k += step;
        }
      }
    }
  }
}
