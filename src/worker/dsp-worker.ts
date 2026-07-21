/// <reference lib="webworker" />
//
// DSP worker: owns the whole signal chain off the main thread.
//
//   cu8 IQ blocks (from WebUSB, on the main thread)
//        │
//        ├─▶ Fft ──────────────▶ waterfall column ──▶ main thread (canvas)
//        │
//        └─▶ Channelizer ─▶ S16 audio ─▶ SampleQueue ─▶ multimon-ng (wasm/JSPI)
//                                                            │
//                                                    decoded packet lines
//                                                            └─▶ main thread
//
// WebUSB is unavailable in workers, so the main thread captures samples and
// transfers their ArrayBuffers here. Everything downstream — FFT, channelize,
// FM demod, and multimon-ng itself — runs here, keeping the UI thread free to
// render the waterfall smoothly.

import { Fft } from "./fft.ts";
import { Channelizer } from "./channelizer.ts";
import { SampleQueue } from "./sample-queue.ts";
import { runMultimon } from "./multimon.ts";
import type { FromWorker, StartParams, ToWorker } from "./protocol.ts";

// 1 MiB (~24 s of 22050 Hz S16) absorbs stalls while multimon loads/decodes.
const AUDIO_QUEUE_CAPACITY = 1 << 20;
// Emit the audio level meter at most this often (ms).
const LEVEL_INTERVAL_MS = 150;

let fft: Fft | undefined;
let channelizer: Channelizer | undefined;
let queue: SampleQueue | undefined;
let running = false;
let sampleRate = 0;
let lastLevelPost = 0;

function post(msg: FromWorker, transfer?: Transferable[]): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);
}

// Bumped on each (re)start so a superseded multimon instance — whose main loop
// exits when we close its queue during a decoder restart — doesn't report a
// spurious "exit" for the run that just replaced it.
let generation = 0;

async function start(params: StartParams): Promise<void> {
  await stop(); // tear down any previous run
  const gen = ++generation;

  sampleRate = params.sampleRate;
  fft = new Fft(params.fftSize);
  channelizer = new Channelizer({
    sampleRate: params.sampleRate,
    audioRate: params.audioRate,
    offsetHz: params.offsetHz,
    channelBandwidthHz: params.channelBandwidthHz,
  });
  queue = new SampleQueue(AUDIO_QUEUE_CAPACITY);
  running = true;

  const q = queue;
  try {
    await runMultimon(q, params.demods, {
      onPacket: (protocol, text) =>
        post({ type: "packet", packet: { protocol, text, time: nowMs() } }),
      onLog: (line) => post({ type: "log", line }),
      onReady: () => post({ type: "ready" }),
      onExit: (message) => {
        if (running && gen === generation) post({ type: "exit", message });
      },
    });
  } catch (e: any) {
    post({ type: "error", message: `multimon load failed: ${e?.message ?? e}` });
    await stop();
  }
}

// Date.now via performance-independent wall clock; workers have Date.
function nowMs(): number {
  return Date.now();
}

function onSamples(data: ArrayBuffer): void {
  if (!running || !fft || !channelizer || !queue) return;
  const cu8 = new Uint8Array(data);

  // Waterfall column (copy so we can transfer it without touching scratch).
  const mags = fft.spectrumFromCu8(cu8).slice();
  post({ type: "waterfall", mags, sampleRate }, [mags.buffer]);

  // Channelize + FM demod -> S16 audio -> multimon's stdin queue.
  const audio = channelizer.feed(cu8);
  if (audio.length) {
    queue.push(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength));
  }

  const t = nowMs();
  if (t - lastLevelPost >= LEVEL_INTERVAL_MS) {
    lastLevelPost = t;
    // overflows: cumulative audio chunks dropped because multimon-ng fell behind
    // the live stream (queue over cap). Surfaced so the user can tell when the
    // browser is silently losing audio — which lowers the decode count.
    post({ type: "audioLevel", rms: channelizer.takeRms(), overflows: queue.overflows() });
  }
}

async function stop(): Promise<void> {
  running = false;
  // Closing the queue resolves multimon's pending read as EOF, so its main loop
  // returns and the wasm unwinds cleanly.
  queue?.close();
  queue = undefined;
  fft = undefined;
  channelizer = undefined;
}

self.addEventListener("message", (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "start":
        void start(msg.params);
        break;
      case "samples":
        onSamples(msg.data);
        break;
      case "tune":
        channelizer?.setOffset(msg.offsetHz);
        break;
      case "stop":
        void stop();
        break;
    }
  } catch (e: any) {
    post({ type: "error", message: e?.message ?? String(e) });
  }
});
