// Message types exchanged between the main thread and the DSP worker.
//
// The main thread owns WebUSB (unavailable in workers) and the UI; the worker
// owns the whole signal chain: FFT for the waterfall, the channelizer/FM
// demodulator, and multimon-ng (wasm). Raw cu8 IQ blocks flow in; waterfall
// columns and decoded packet lines flow back.

/** Parameters to (re)start the signal chain. */
export interface StartParams {
  /** SDR sample rate, in Hz (the full span shown on the waterfall). */
  sampleRate: number;
  /** Audio rate handed to multimon-ng, in Hz (its demods expect 22050). */
  audioRate: number;
  /** Selected channel offset from the tuned center, in Hz. */
  offsetHz: number;
  /** FM discriminator bandwidth / channel low-pass cutoff, in Hz. */
  channelBandwidthHz: number;
  /** multimon-ng demodulators to enable, e.g. ["POCSAG1200", "FLEX"]. */
  demods: string[];
  /** FFT size for the waterfall (power of two). */
  fftSize: number;
}

/** Main thread -> worker. */
export type ToWorker =
  | { type: "start"; params: StartParams }
  | { type: "samples"; data: ArrayBuffer }
  | { type: "tune"; offsetHz: number }
  | { type: "stop" };

/** One decoded packet from multimon-ng (a parsed stdout line). */
export interface Packet {
  /** Protocol tag, e.g. "POCSAG1200", "FLEX", "AFSK1200". */
  protocol: string;
  /** The full decoded line (address, function, message, …). */
  text: string;
  /** Wall-clock time the line was decoded (ms since epoch). */
  time: number;
}

/** Worker -> main thread. */
export type FromWorker =
  | { type: "ready" }
  | { type: "waterfall"; mags: Float32Array; sampleRate: number }
  | { type: "audioLevel"; rms: number }
  | { type: "packet"; packet: Packet }
  | { type: "log"; line: string }
  | { type: "error"; message: string }
  | { type: "exit"; message: string };
