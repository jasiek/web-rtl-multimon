// Channelizer + FM demodulator: turns a wideband cu8 IQ stream into narrowband
// signed-16-bit mono audio for one selectable channel, ready for multimon-ng.
//
// Pipeline, per input sample:
//   cu8 IQ ─NCO mix (−offset)─▶ baseband
// then, decimating in two stages down to the audio rate:
//   ─FIR ↓D1─▶ intermediate ─FIR ↓D2─▶ audio-rate complex
// then:
//   ─FM discriminator─▶ ─DC block─▶ ×gain ─▶ int16 PCM
//
// The NCO runs at the full SDR rate (every sample is mixed); the FIRs only
// evaluate at their decimated output rates, so cost stays modest. The total
// decimation D1·D2 must equal sampleRate/audioRate exactly, which the caller
// guarantees by choosing an SDR rate that is an integer multiple of the audio
// rate — so multimon-ng sees audio at precisely the rate its demods assume.

/** Odd FIR length for a Hamming filter with the given transition width. */
function tapsForTransition(transitionHz: number, sampleRate: number): number {
  // Hamming main-lobe rule of thumb: transition ≈ 3.3·Fs/N.
  let n = Math.ceil((3.3 * sampleRate) / Math.max(1, transitionHz));
  if (n % 2 === 0) n++;
  return Math.min(Math.max(n, 15), 401); // keep the per-output cost bounded
}

/** Hamming-windowed low-pass FIR with unity DC gain. */
function lowpassTaps(cutoffHz: number, sampleRate: number, n: number): Float32Array {
  const taps = new Float32Array(n);
  const fc = cutoffHz / sampleRate; // normalized cutoff
  const mid = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hamming
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < n; i++) taps[i] /= sum;
  return taps;
}

/** A complex FIR that emits one output every `decim` input samples. */
class DecimatingFir {
  private readonly taps: Float32Array;
  private readonly len: number;
  private readonly histI: Float32Array;
  private readonly histQ: Float32Array;
  private writePos = 0;
  private count = 0;
  private readonly decim: number;

  constructor(taps: Float32Array, decim: number) {
    this.taps = taps;
    this.len = taps.length;
    this.histI = new Float32Array(this.len);
    this.histQ = new Float32Array(this.len);
    this.decim = decim;
  }

  /** Push one complex sample; returns [I, Q] on decimated outputs, else null. */
  push(i: number, q: number, out: Float32Array): boolean {
    const L = this.len;
    this.histI[this.writePos] = i;
    this.histQ[this.writePos] = q;
    this.writePos = (this.writePos + 1) % L;

    if (++this.count < this.decim) return false;
    this.count = 0;

    // y = Σ taps[k] · x[n−k]; newest sample is at (writePos−1).
    let accI = 0;
    let accQ = 0;
    let idx = (this.writePos - 1 + L) % L;
    const taps = this.taps;
    for (let k = 0; k < L; k++) {
      const t = taps[k];
      accI += t * this.histI[idx];
      accQ += t * this.histQ[idx];
      idx = idx === 0 ? L - 1 : idx - 1;
    }
    out[0] = accI;
    out[1] = accQ;
    return true;
  }
}

export interface ChannelizerParams {
  sampleRate: number; // SDR rate (Hz)
  audioRate: number; // output rate (Hz), must divide sampleRate
  offsetHz: number; // channel offset from tuned center (Hz)
  channelBandwidthHz: number; // channel low-pass cutoff (Hz)
}

/**
 * Factor `total` into (D1, D2). D1 is the coarse stage (does most of the
 * decimation with a cheap wide filter); D2 is the fine stage carrying the
 * narrow channel-select filter. We aim for the intermediate rate ≈ 4× the
 * audio rate (D2 ≈ 4), which keeps the narrow filter's tap count reasonable.
 */
function splitDecimation(total: number): [number, number] {
  const prefer = [4, 5, 3, 2, 6, 8, 7];
  for (const d2 of prefer) {
    if (d2 < total && total % d2 === 0) return [total / d2, d2];
  }
  return [total, 1]; // prime total: single stage
}

export class Channelizer {
  private readonly sampleRate: number;
  // NCO (down-conversion) incremental phasor.
  private co = 1;
  private si = 0;
  private dco: number;
  private dsi: number;
  private ncoCount = 0;
  // Two decimation stages.
  private stage1: DecimatingFir;
  private stage2: DecimatingFir;
  private readonly s1out = new Float32Array(2);
  private readonly s2out = new Float32Array(2);
  // FM discriminator memory.
  private prevI = 0;
  private prevQ = 0;
  // DC blocker memory.
  private dcX = 0;
  private dcY = 0;
  // Output scaling.
  private readonly gain: number;
  // Total decimation D1·D2 (used to size the output buffer).
  private readonly totalDecim: number;
  // Running audio RMS for the level meter.
  private rmsAcc = 0;
  private rmsN = 0;

  constructor(p: ChannelizerParams) {
    this.sampleRate = p.sampleRate;
    const total = Math.round(p.sampleRate / p.audioRate);
    this.totalDecim = total;
    const [d1, d2] = splitDecimation(total);
    const interRate = p.sampleRate / d1;
    const channelBW = p.channelBandwidthHz;

    // Stage 1 (coarse): pass a guard band a little wider than the channel and
    // reach the stopband before the first alias would fold back into that
    // guard (at interRate − guard). The transition between is allowed to alias
    // into the guard region — stage 2 removes everything outside the channel.
    const guard = Math.max(channelBW * 1.5, 12_000);
    const s1trans = Math.max(interRate - 2 * guard, interRate * 0.1);
    const s1taps = lowpassTaps(guard, p.sampleRate, tapsForTransition(s1trans, p.sampleRate));
    this.stage1 = new DecimatingFir(s1taps, d1);

    // Stage 2 (fine): the narrow channel-select filter, and the final
    // anti-alias before decimating to the audio rate. Reject by
    // (audioRate − channelBW) so nothing folds into the channel.
    const s2trans = Math.max(p.audioRate - 2 * channelBW, p.audioRate * 0.1);
    const s2taps = lowpassTaps(channelBW, interRate, tapsForTransition(s2trans, interRate));
    this.stage2 = new DecimatingFir(s2taps, d2);

    // Discriminator scaling matched to rtl_fm's `-M fm`, so the audio level fed
    // to multimon-ng is the same as the printed native pipeline. rtl_fm emits
    // atan2(...)·(1<<14)/π as int16 — a full ±π rad/sample phase step maps to
    // half of int16 full scale, independent of the channel width. We hold audio
    // in [-1, 1] before the ×32767 quantize, so the equivalent factor is 0.5/π.
    // Deliberately NOT tied to channelBandwidthHz: coupling the gain to the
    // bandwidth slider (as it was before) made the level — and thus what the
    // slicer sees — diverge from rtl_fm and shift the decode count.
    this.gain = 0.5 / Math.PI;

    this.dco = Math.cos((-2 * Math.PI * p.offsetHz) / p.sampleRate);
    this.dsi = Math.sin((-2 * Math.PI * p.offsetHz) / p.sampleRate);
  }

  /** Retune to a new channel offset without rebuilding the filters. */
  setOffset(offsetHz: number): void {
    this.dco = Math.cos((-2 * Math.PI * offsetHz) / this.sampleRate);
    this.dsi = Math.sin((-2 * Math.PI * offsetHz) / this.sampleRate);
  }

  /** RMS of the audio produced since the last read (0..1), then reset. */
  takeRms(): number {
    if (this.rmsN === 0) return 0;
    const rms = Math.sqrt(this.rmsAcc / this.rmsN);
    this.rmsAcc = 0;
    this.rmsN = 0;
    return rms;
  }

  /**
   * Process a cu8 IQ block and return the S16LE mono audio it produced. The
   * returned Int16Array's buffer is freshly allocated and safe to transfer.
   */
  feed(cu8: Uint8Array): Int16Array {
    const complexCount = cu8.length >> 1;
    // One audio sample per (D1·D2) inputs; size generously.
    const out = new Int16Array(Math.ceil(complexCount / this.totalDecim) + 4);
    let n = 0;

    for (let s = 0; s < complexCount; s++) {
      // cu8 -> float, centered.
      const rawI = (cu8[2 * s] - 127.4) / 128;
      const rawQ = (cu8[2 * s + 1] - 127.4) / 128;

      // NCO mix down by offset: (rawI + j rawQ) · (co + j si).
      const mI = rawI * this.co - rawQ * this.si;
      const mQ = rawI * this.si + rawQ * this.co;

      // Advance and periodically renormalize the phasor (bounds drift).
      const nco = this.co * this.dco - this.si * this.dsi;
      const nsi = this.co * this.dsi + this.si * this.dco;
      this.co = nco;
      this.si = nsi;
      if (++this.ncoCount >= 1024) {
        this.ncoCount = 0;
        const mag = Math.hypot(this.co, this.si) || 1;
        this.co /= mag;
        this.si /= mag;
      }

      if (!this.stage1.push(mI, mQ, this.s1out)) continue;
      if (!this.stage2.push(this.s1out[0], this.s1out[1], this.s2out)) continue;

      // FM discriminator: angle of current · conj(previous).
      const I = this.s2out[0];
      const Q = this.s2out[1];
      const real = I * this.prevI + Q * this.prevQ;
      const imag = Q * this.prevI - I * this.prevQ;
      this.prevI = I;
      this.prevQ = Q;
      let audio = Math.atan2(imag, real) * this.gain;

      // One-pole DC blocker to remove residual carrier offset.
      const y = audio - this.dcX + 0.9995 * this.dcY;
      this.dcX = audio;
      this.dcY = y;
      audio = y;

      // Level meter accumulation.
      this.rmsAcc += audio * audio;
      this.rmsN++;

      // Clamp and quantize to S16.
      const v = audio > 1 ? 1 : audio < -1 ? -1 : audio;
      out[n++] = (v * 32767) | 0;
    }
    // subarray shares the buffer; copy so the caller can transfer it safely.
    return out.slice(0, n);
  }
}
