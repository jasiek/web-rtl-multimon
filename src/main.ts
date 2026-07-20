// Page controller: wires WebUSB sample capture (main thread) to the DSP worker
// (FFT waterfall + channelizer/FM-demod + multimon-ng) and renders the results.
//
// The main thread only touches the radio and the DOM. Every heavy step — FFT,
// channelize, FM demod, and multimon-ng itself — lives in the worker, so the
// waterfall stays smooth. Captured cu8 blocks are transferred to the worker;
// waterfall columns and decoded packets come back.
import { Sdr, type SampleSink } from "./sdr";
import { Waterfall } from "./waterfall";
import type { FromWorker, StartParams, ToWorker } from "./worker/protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  freq: $<HTMLInputElement>("freq"),
  rate: $<HTMLSelectElement>("rate"),
  gain: $<HTMLSelectElement>("gain"),
  bw: $<HTMLInputElement>("bw"),
  fft: $<HTMLSelectElement>("fft"),
  connect: $<HTMLButtonElement>("connect"),
  apply: $<HTMLButtonElement>("apply"),
  stop: $<HTMLButtonElement>("stop"),
  dot: $<HTMLSpanElement>("dot"),
  statusText: $<HTMLSpanElement>("statusText"),
  count: $<HTMLElement>("count"),
  chan: $<HTMLElement>("chan"),
  overflow: $<HTMLElement>("overflow"),
  meter: $<HTMLElement>("meter"),
  rows: $<HTMLTableSectionElement>("rows"),
  log: $<HTMLElement>("log"),
  wfwrap: $<HTMLElement>("wfwrap"),
  unsupported: $<HTMLElement>("unsupported"),
};

// multimon-ng's demodulators fix the input rate at 22050 Hz.
const AUDIO_RATE = 22050;

const sdr = new Sdr();
const waterfall = new Waterfall(els.wfwrap);
let worker: Worker | null = null;
let offsetHz = 0;
let packetCount = 0;
let active: { centerFrequency: number; sampleRate: number } | null = null;

// --- environment checks ------------------------------------------------------
function checkSupport(): string | null {
  if (!("usb" in navigator)) {
    return "WebUSB is not available in this browser. Use a Chromium-based browser (Chrome, Edge) over HTTPS or localhost.";
  }
  if (typeof (WebAssembly as any).Suspending !== "function") {
    return "This browser lacks WebAssembly JSPI (stack switching), which the decoder needs. Use a recent Chromium-based browser (Chrome/Edge 137+).";
  }
  return null;
}

// --- helpers -----------------------------------------------------------------
function setStatus(text: string, state: "idle" | "on" | "err") {
  els.statusText.textContent = text;
  els.dot.className = "dot" + (state === "on" ? " on" : state === "err" ? " err" : "");
}

function logLines(lines: string[]) {
  if (!lines.length) return;
  els.log.textContent = (els.log.textContent + "\n" + lines.join("\n"))
    .split("\n")
    .slice(-200)
    .join("\n");
  els.log.scrollTop = els.log.scrollHeight;
}
const logLine = (line: string) => logLines([line]);

function selectedDemods(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('.demods input[type="checkbox"]:checked'),
  ).map((c) => c.value);
}

function dspParams(sampleRate: number): StartParams {
  return {
    sampleRate,
    audioRate: AUDIO_RATE,
    offsetHz,
    channelBandwidthHz: Math.max(2500, parseFloat(els.bw.value) * 1000),
    demods: selectedDemods(),
    fftSize: parseInt(els.fft.value, 10),
  };
}

function updateChannelReadout() {
  if (!active) {
    els.chan.textContent = "—";
    return;
  }
  els.chan.textContent = `${((active.centerFrequency + offsetHz) / 1e6).toFixed(4)} MHz`;
}

// --- packet rendering --------------------------------------------------------
function addPacket(protocol: string, text: string, timeMs: number) {
  if (els.rows.querySelector(".empty")) els.rows.innerHTML = "";
  const tr = document.createElement("tr");
  tr.className = "flash";
  const t = new Date(timeMs).toLocaleTimeString();
  tr.innerHTML =
    `<td>${t}</td>` +
    `<td class="proto">${escapeHtml(protocol)}</td>` +
    `<td class="msg">${escapeHtml(text)}</td>`;
  els.rows.prepend(tr);
  while (els.rows.children.length > 300) els.rows.lastElementChild?.remove();
  packetCount++;
  els.count.textContent = String(packetCount);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// --- worker plumbing ---------------------------------------------------------
function post(msg: ToWorker, transfer?: Transferable[]) {
  worker?.postMessage(msg, transfer ?? []);
}

function handleWorkerMessage(msg: FromWorker) {
  switch (msg.type) {
    case "ready":
      if (!active) return;
      setStatus(`Listening @ ${(active.centerFrequency / 1e6).toFixed(3)} MHz`, "on");
      els.apply.disabled = false;
      els.stop.disabled = false;
      startPump();
      break;
    case "waterfall":
      waterfall.pushColumn(msg.mags);
      break;
    case "audioLevel":
      els.meter.style.width = `${Math.min(100, msg.rms * 140).toFixed(0)}%`;
      break;
    case "packet":
      addPacket(msg.packet.protocol, msg.packet.text, msg.packet.time);
      break;
    case "log":
      logLine(msg.line);
      break;
    case "error":
      setStatus("Decoder error", "err");
      logLine(`error: ${msg.message}`);
      break;
    case "exit":
      logLine(`decoder: ${msg.message}`);
      break;
  }
}

// The SDR pump feeds captured cu8 blocks straight to the worker (transferred).
const workerSink: SampleSink = {
  push(bytes: Uint8Array) {
    if (!worker) return;
    const copy = bytes.slice(); // own the bytes; the SDR reuses its read buffer
    worker.postMessage({ type: "samples", data: copy.buffer } satisfies ToWorker, [copy.buffer]);
  },
  overflows: () => 0,
};

// --- lifecycle ---------------------------------------------------------------
async function connect() {
  const support = checkSupport();
  if (support) {
    setStatus("Unsupported", "err");
    return;
  }

  const centerFrequency = Math.round(parseFloat(els.freq.value) * 1e6);
  const sampleRate = parseInt(els.rate.value, 10);
  const gain = els.gain.value === "auto" ? undefined : parseFloat(els.gain.value);

  els.connect.disabled = true;
  setStatus("Requesting device…", "idle");

  let actual: { sampleRate: number; centerFrequency: number };
  try {
    actual = await sdr.connect({ centerFrequency, sampleRate, gain });
  } catch (e: any) {
    setStatus("Connect failed", "err");
    logLine(`connect error: ${e?.message ?? e}`);
    els.connect.disabled = false;
    return;
  }
  active = actual;
  offsetHz = 0;

  waterfall.setChannel(actual.centerFrequency, actual.sampleRate);
  waterfall.setBandwidth(Math.max(2500, parseFloat(els.bw.value) * 1000));
  waterfall.setOffset(0);
  updateChannelReadout();

  // Spin up the DSP worker and hand it the signal-chain parameters.
  worker = new Worker(new URL("./worker/dsp-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<FromWorker>) => handleWorkerMessage(ev.data);
  worker.onerror = (e) => {
    setStatus("Worker error", "err");
    logLine(`worker error: ${e.message}`);
  };

  setStatus("Loading decoder…", "idle");
  post({ type: "start", params: dspParams(actual.sampleRate) });

  logLine(
    `connected: ${(actual.centerFrequency / 1e6).toFixed(3)} MHz @ ${(actual.sampleRate / 1e3).toFixed(0)} kHz span, ` +
      `gain ${gain == null ? "auto (AGC)" : gain.toFixed(1) + " dB"}`,
  );
}

// Started once the worker reports the decoder is ready (see handleWorkerMessage).
async function startPump() {
  await sdr.resetBuffer().catch(() => {});
  sdr
    .pump(workerSink, undefined, (warning) => logLine(warning))
    .catch((e) => {
      setStatus("USB read failed", "err");
      logLine(`pump stopped: ${e?.message ?? e}`);
    });
}

// Restart the decoders with the current channel-width / FFT / demod selection,
// without touching the (still-running) radio.
function applyDsp() {
  if (!active || !worker) return;
  waterfall.setBandwidth(Math.max(2500, parseFloat(els.bw.value) * 1000));
  setStatus("Applying…", "idle");
  post({ type: "start", params: dspParams(active.sampleRate) });
  logLine(`decoders restarted: ${selectedDemods().join(", ") || "(none)"}`);
}

async function stop() {
  els.stop.disabled = true;
  els.apply.disabled = true;
  active = null;
  updateChannelReadout();
  await sdr.stop();
  post({ type: "stop" });
  worker?.terminate();
  worker = null;
  setStatus("Stopped", "idle");
  els.connect.disabled = false;
}

// --- init --------------------------------------------------------------------
waterfall.onTune = (hz) => {
  offsetHz = hz;
  post({ type: "tune", offsetHz });
  updateChannelReadout();
};

const support = checkSupport();
if (support) {
  els.unsupported.hidden = false;
  els.unsupported.textContent = support;
  if (!("usb" in navigator)) els.connect.disabled = true;
}
els.connect.addEventListener("click", connect);
els.apply.addEventListener("click", applyDsp);
els.stop.addEventListener("click", stop);
