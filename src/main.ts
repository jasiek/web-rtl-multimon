// Page controller: wires WebUSB sample capture (main thread) to the DSP worker
// (FFT waterfall + channelizer/FM-demod + multimon-ng) and renders the results.
//
// Lifecycle is split so the device is picked only once:
//   • Pair  — one gesture-gated WebUSB chooser; the browser then remembers the
//             dongle, so Start/Stop never prompt again (they use getDevices()).
//   • Start — open the paired dongle, spin up the worker, begin streaming.
//   • Stop  — halt streaming and release the dongle (still paired).
// All parameters auto-apply while running: frequency and the waterfall marker
// retune live; channel width / FFT / demods restart just the decoder; sample
// rate / gain do a quick transparent stream restart. None re-prompt.
import { Sdr, type SampleSink } from "./sdr";
import { Waterfall } from "./waterfall";
import type { FromWorker, StartParams, ToWorker } from "./worker/protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  preset: $<HTMLSelectElement>("preset"),
  freq: $<HTMLInputElement>("freq"),
  rate: $<HTMLSelectElement>("rate"),
  gain: $<HTMLSelectElement>("gain"),
  bw: $<HTMLInputElement>("bw"),
  fft: $<HTMLSelectElement>("fft"),
  pair: $<HTMLButtonElement>("pair"),
  start: $<HTMLButtonElement>("start"),
  stop: $<HTMLButtonElement>("stop"),
  dot: $<HTMLSpanElement>("dot"),
  statusText: $<HTMLSpanElement>("statusText"),
  count: $<HTMLElement>("count"),
  lostrf: $<HTMLElement>("lostrf"),
  selFreq: $<HTMLElement>("selFreq"),
  curFreq: $<HTMLElement>("curFreq"),
  overflow: $<HTMLElement>("overflow"),
  meter: $<HTMLElement>("meter"),
  rows: $<HTMLTableSectionElement>("rows"),
  clear: $<HTMLButtonElement>("clear"),
  log: $<HTMLElement>("log"),
  wfwrap: $<HTMLElement>("wfwrap"),
  cmdline: $<HTMLElement>("cmdline"),
  copyCmd: $<HTMLButtonElement>("copyCmd"),
  unsupported: $<HTMLElement>("unsupported"),
};

// multimon-ng's demodulators fix the input rate at 22050 Hz.
const AUDIO_RATE = 22050;

// Known pager allocations by country (frequency in MHz). Sourced from public
// pager/scanner references — see README. These are network centers; actual
// on-air channels vary regionally, so treat them as starting points.
interface Preset {
  flag: string;
  country: string;
  mhz: number;
  label: string;
}
const PRESETS: Preset[] = [
  { flag: "🇳🇱", country: "Netherlands", mhz: 169.65, label: "P2000 emergency (FLEX)" },
  { flag: "🇬🇧", country: "UK", mhz: 153.35, label: "wide-area (POCSAG)" },
  { flag: "🇬🇧", country: "UK", mhz: 153.25, label: "wide-area (POCSAG)" },
  { flag: "🇬🇧", country: "UK", mhz: 138.15, label: "PageOne (POCSAG)" },
  { flag: "🇸🇪", country: "Sweden", mhz: 169.8, label: "Minicall (POCSAG)" },
  { flag: "🇩🇪", country: "Germany", mhz: 466.075, label: "Cityruf (POCSAG)" },
  { flag: "🇩🇪", country: "Germany", mhz: 448.425, label: "e*Message/BOS (POCSAG)" },
  { flag: "🇫🇷", country: "France", mhz: 466.025, label: "Alphapage (POCSAG)" },
  { flag: "🇪🇺", country: "Europe", mhz: 439.9875, label: "DAPNET amateur (POCSAG)" },
  { flag: "🇺🇸", country: "USA", mhz: 929.9375, label: "American Messaging (FLEX)" },
  { flag: "🇺🇸", country: "USA", mhz: 931.0625, label: "FLEX / POCSAG" },
  { flag: "🇺🇸", country: "USA/Canada", mhz: 931.9375, label: "SkyTel nationwide (FLEX)" },
  { flag: "🇨🇦", country: "Canada", mhz: 929.2875, label: "PageNet (POCSAG)" },
];

const sdr = new Sdr();
const waterfall = new Waterfall(els.wfwrap);
let worker: Worker | null = null;
let paired = false;
let streaming = false;
let pumpRunning = false;
let pumpPromise: Promise<void> | null = null;
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

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function updateButtons() {
  els.pair.disabled = false;
  els.start.disabled = !paired || streaming;
  els.stop.disabled = !streaming;
}

function selectedDemods(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('.demods input[type="checkbox"]:checked'),
  ).map((c) => c.value);
}

function bandwidthHz(): number {
  return Math.max(2500, parseFloat(els.bw.value) * 1000);
}

function deviceOpts() {
  return {
    centerFrequency: Math.round(parseFloat(els.freq.value) * 1e6),
    sampleRate: parseInt(els.rate.value, 10),
    gain: els.gain.value === "auto" ? undefined : parseFloat(els.gain.value),
  };
}

function dspParams(sampleRate: number): StartParams {
  return {
    sampleRate,
    audioRate: AUDIO_RATE,
    offsetHz,
    channelBandwidthHz: bandwidthHz(),
    demods: selectedDemods(),
    fftSize: parseInt(els.fft.value, 10),
  };
}

function fmtMHz(hz: number): string {
  return `${(hz / 1e6).toFixed(4)} MHz`;
}

function updateChannelReadout() {
  els.selFreq.textContent = active ? fmtMHz(active.centerFrequency + offsetHz) : "—";
  updateCommand();
}

// The concrete channel the user has selected: SDR center (once streaming) or
// the frequency field, plus the waterfall offset.
function selectedHz(): number {
  const center = active ? active.centerFrequency : Math.round(parseFloat(els.freq.value) * 1e6);
  return center + offsetHz;
}

// The native `rtl_fm | multimon-ng` pipeline equivalent to the current settings.
// rtl_fm tunes straight to the selected channel and FM-demodulates it to 22050
// Hz audio — exactly what the in-browser channelizer does — so it uses the
// selected frequency (not the wide waterfall span) and -s 22050.
function buildCommand(): { plain: string; html: string } {
  const fMHz = (selectedHz() / 1e6).toFixed(4);
  const gain = els.gain.value === "auto" ? "" : ` -g ${parseFloat(els.gain.value)}`;
  const demods = selectedDemods();
  const aflags = (demods.length ? demods : ["POCSAG1200"]).map((d) => `-a ${d}`).join(" ");
  const plain =
    `rtl_fm -f ${fMHz}M -M fm -s ${AUDIO_RATE}${gain} - | ` +
    `multimon-ng -t raw ${aflags} -`;
  // A lightly highlighted version for display.
  const html = escapeHtml(plain)
    .replace(/(-[a-zA-Z])\b/g, '<span class="flag">$1</span>')
    .replace(/ \| /g, ' <span class="pipe">|</span> ');
  return { plain, html };
}

function updateCommand() {
  els.cmdline.innerHTML = buildCommand().html;
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

const EMPTY_ROW =
  '<tr><td colspan="3" class="empty">No packets yet. Pair an RTL-SDR, press Start, tune to a pager channel, and wait for traffic.</td></tr>';

function clearPackets() {
  els.rows.innerHTML = EMPTY_ROW;
  packetCount = 0;
  els.count.textContent = "0";
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
      if (!streaming || !active) return;
      setStatus(`Listening @ ${(active.centerFrequency / 1e6).toFixed(3)} MHz`, "on");
      // Begin the USB read loop only once per stream — a decoder restart also
      // fires "ready", and starting a second pump would issue concurrent USB
      // reads on one dongle (which fail as "USB read error").
      startPumpOnce();
      break;
    case "waterfall":
      waterfall.pushColumn(msg.mags);
      break;
    case "audioLevel":
      els.meter.style.width = `${Math.min(100, msg.rms * 140).toFixed(0)}%`;
      // Dropped audio chunks: multimon-ng fell behind and the queue shed its
      // oldest samples, so some airtime was never decoded. Flag it in red when
      // it happens — otherwise the loss is invisible and looks like dead air.
      els.overflow.textContent = String(msg.overflows);
      els.overflow.style.color = msg.overflows > 0 ? "var(--danger)" : "";
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

// Estimated fraction of RF samples lost before decoding (host can't keep up
// with the USB stream). Green under 1%, amber to 5%, red above — a live proxy
// for the single-buffered-read starvation that the audio "Dropped" stat misses.
function updateRfLoss(pct: number) {
  els.lostrf.textContent = pct < 1 ? `${pct.toFixed(1)}%` : `${pct.toFixed(0)}%`;
  els.lostrf.style.color = pct >= 5 ? "var(--danger)" : pct >= 1 ? "#e5a54b" : "";
}

function startPumpOnce() {
  if (pumpRunning) return;
  pumpRunning = true;
  pumpPromise = (async () => {
    await sdr.resetBuffer().catch(() => {});
    await sdr
      .pump(workerSink, undefined, (warning) => logLine(warning), updateRfLoss)
      .catch((e) => {
      if (streaming) {
        setStatus("USB read failed", "err");
        logLine(`pump stopped: ${e?.message ?? e}`);
      }
    });
  })();
}

// --- lifecycle ---------------------------------------------------------------
async function pair() {
  const support = checkSupport();
  if (support) {
    setStatus("Unsupported", "err");
    return;
  }
  els.pair.disabled = true;
  setStatus("Pairing…", "idle");
  try {
    await sdr.pair();
    paired = true;
    setStatus("Paired — press Start", "idle");
  } catch (e: any) {
    setStatus("Pairing cancelled", "idle");
    logLine(`pair: ${e?.message ?? e}`);
  }
  updateButtons();
}

// Open the paired dongle, spin up the worker, and begin streaming.
async function openAndRun() {
  const opts = deviceOpts();
  let actual: { sampleRate: number; centerFrequency: number };
  try {
    actual = await sdr.start(opts);
  } catch (e: any) {
    setStatus("Start failed", "err");
    logLine(`start error: ${e?.message ?? e}`);
    throw e;
  }
  active = actual;

  waterfall.setChannel(actual.centerFrequency, actual.sampleRate);
  waterfall.setBandwidth(bandwidthHz());
  waterfall.setOffset(offsetHz);
  updateChannelReadout();

  // Fresh stream -> fresh drop counter (the worker's SampleQueue is recreated).
  els.overflow.textContent = "0";
  els.overflow.style.color = "";
  els.lostrf.textContent = "0%";
  els.lostrf.style.color = "";

  worker = new Worker(new URL("./worker/dsp-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<FromWorker>) => handleWorkerMessage(ev.data);
  worker.onerror = (e) => {
    setStatus("Worker error", "err");
    logLine(`worker error: ${e.message}`);
  };
  setStatus("Loading decoder…", "idle");
  post({ type: "start", params: dspParams(actual.sampleRate) });

  logLine(
    `streaming: ${(actual.centerFrequency / 1e6).toFixed(3)} MHz @ ${(actual.sampleRate / 1e3).toFixed(0)} kHz span, ` +
      `gain ${opts.gain == null ? "auto (AGC)" : opts.gain.toFixed(1) + " dB"}`,
  );
}

// Halt streaming: stop the pump, release the dongle, tear down the worker.
async function teardown() {
  pumpRunning = false;
  await sdr.stop(); // closes the device -> the pending readSamples rejects
  await pumpPromise?.catch(() => {});
  pumpPromise = null;
  post({ type: "stop" });
  worker?.terminate();
  worker = null;
  active = null;
}

async function startStream() {
  if (streaming) return;
  els.start.disabled = true;
  streaming = true;
  try {
    await openAndRun();
  } catch {
    streaming = false;
  }
  updateButtons();
}

async function stopStream() {
  if (!streaming) return;
  streaming = false;
  els.stop.disabled = true;
  await teardown();
  updateChannelReadout();
  els.meter.style.width = "0";
  setStatus("Stopped", "idle");
  updateButtons();
}

// Restart the whole stream (device reopen + worker) — for sample-rate/gain
// changes. Silent: the dongle stays paired, so no chooser appears.
async function restartStream() {
  if (!streaming) return;
  setStatus("Restarting…", "idle");
  await teardown();
  try {
    await openAndRun();
  } catch {
    streaming = false;
    updateButtons();
  }
}

// Restart just the decoders (worker only) — for channel width / FFT / demod
// changes. The radio and the USB pump keep running untouched.
function restartDecoder() {
  if (!streaming || !worker || !active) return;
  waterfall.setBandwidth(bandwidthHz());
  post({ type: "start", params: dspParams(active.sampleRate) });
  logLine(`decoders restarted: ${selectedDemods().join(", ") || "(none)"}`);
}

// --- parameter change handlers (auto-apply) ---------------------------------
function applyFrequency() {
  updateCommand(); // reflect the current frequency even before streaming
  if (!streaming || !active) return;
  const freq = Math.round(parseFloat(els.freq.value) * 1e6);
  if (!Number.isFinite(freq)) return;
  sdr
    .setCenterFrequency(freq)
    .then((actualFreq) => {
      active!.centerFrequency = actualFreq;
      waterfall.setChannel(actualFreq, active!.sampleRate);
      updateChannelReadout();
    })
    .catch((e) => logLine(`retune failed: ${e?.message ?? e}`));
}
const onFreqChange = debounce(applyFrequency, 200);

// Populate the preset dropdown and apply a chosen preset as the new center
// frequency (offset reset to 0 so the decoded channel is exactly the preset).
function populatePresets() {
  for (const p of PRESETS) {
    const opt = document.createElement("option");
    opt.value = String(p.mhz);
    opt.textContent = `${p.flag} ${p.mhz.toFixed(4)} MHz · ${p.country} ${p.label}`;
    els.preset.appendChild(opt);
  }
}

function onPresetChange() {
  const v = els.preset.value;
  els.preset.value = ""; // reset to the "Choose…" placeholder
  if (!v) return;
  els.freq.value = v;
  offsetHz = 0;
  waterfall.setOffset(0);
  if (streaming) post({ type: "tune", offsetHz: 0 });
  applyFrequency();
  logLine(`preset: ${v} MHz`);
}

const onBandwidthChange = debounce(() => {
  waterfall.setBandwidth(bandwidthHz());
  if (streaming) restartDecoder();
}, 350);

const onDemodChange = debounce(() => {
  updateCommand();
  restartDecoder();
}, 250);

// --- init --------------------------------------------------------------------
waterfall.onTune = (hz) => {
  offsetHz = hz;
  if (streaming) post({ type: "tune", offsetHz });
  updateChannelReadout();
};

// Live frequency under the cursor (meaningful once tuned, i.e. streaming).
waterfall.onHover = (hz) => {
  els.curFreq.textContent = hz == null || !active ? "—" : fmtMHz(hz);
};

els.pair.addEventListener("click", pair);
els.start.addEventListener("click", startStream);
els.stop.addEventListener("click", stopStream);
els.clear.addEventListener("click", clearPackets);
els.preset.addEventListener("change", onPresetChange);
els.freq.addEventListener("input", onFreqChange);
els.bw.addEventListener("input", onBandwidthChange);
els.fft.addEventListener("change", () => streaming && restartDecoder());
els.rate.addEventListener("change", () => streaming && restartStream());
els.gain.addEventListener("change", () => {
  updateCommand();
  if (streaming) restartStream();
});
els.copyCmd.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(buildCommand().plain);
    const prev = els.copyCmd.textContent;
    els.copyCmd.textContent = "Copied";
    setTimeout(() => (els.copyCmd.textContent = prev), 1200);
  } catch {
    logLine("copy failed — select the command text manually");
  }
});
document
  .querySelectorAll<HTMLInputElement>('.demods input[type="checkbox"]')
  .forEach((c) => c.addEventListener("change", onDemodChange));

const support = checkSupport();
if (support) {
  els.unsupported.hidden = false;
  els.unsupported.textContent = support;
  els.pair.disabled = true;
} else {
  // If a dongle was authorized in a previous session, it's still paired.
  sdr.isPaired().then((yes) => {
    if (yes && !streaming) {
      paired = true;
      setStatus("Paired — press Start", "idle");
      updateButtons();
    }
  });
}
populatePresets();
updateButtons();
updateCommand();
