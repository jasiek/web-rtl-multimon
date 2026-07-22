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
import "./style.css";
import { track } from "./analytics";
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
  status: $<HTMLSpanElement>("status"),
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

// Preset frequencies (in MHz) grouped by the multimon-ng protocol they carry.
// Sourced from public references — see README. Many are network/band *centers*;
// on-air channels vary regionally, so treat them as starting points and scan
// nearby. Only protocols with a real, fixed, tunable channel are listed —
// band-agnostic tone standards (DTMF, CCIR, ZVEI, EEA, EIA), telephone-line
// CLIPFSK, and inactive GSC have no single frequency to jump to.
interface Preset {
  group: string; // <optgroup> the entry appears under (protocol family)
  flag: string;
  country: string;
  mhz: number;
  label: string;
}
const PRESETS: Preset[] = [
  // --- FLEX pagers ---------------------------------------------------------
  { group: "FLEX pagers", flag: "🇳🇱", country: "Netherlands", mhz: 169.65, label: "P2000 emergency" },
  { group: "FLEX pagers", flag: "🇺🇸", country: "USA", mhz: 929.9375, label: "American Messaging" },
  { group: "FLEX pagers", flag: "🇺🇸", country: "USA", mhz: 931.3375, label: "Spok" },
  { group: "FLEX pagers", flag: "🇺🇸", country: "USA", mhz: 931.0625, label: "FLEX / POCSAG carrier" },
  { group: "FLEX pagers", flag: "🇺🇸", country: "USA/Canada", mhz: 931.9375, label: "SkyTel nationwide" },
  // --- POCSAG pagers -------------------------------------------------------
  { group: "POCSAG pagers", flag: "🇳🇱", country: "Netherlands", mhz: 172.45, label: "KPN public" },
  { group: "POCSAG pagers", flag: "🇬🇧", country: "UK", mhz: 153.35, label: "wide-area" },
  { group: "POCSAG pagers", flag: "🇬🇧", country: "UK", mhz: 153.25, label: "wide-area" },
  { group: "POCSAG pagers", flag: "🇬🇧", country: "UK", mhz: 138.15, label: "PageOne" },
  { group: "POCSAG pagers", flag: "🇸🇪", country: "Sweden", mhz: 169.8, label: "Minicall" },
  { group: "POCSAG pagers", flag: "🇩🇪", country: "Germany", mhz: 465.97, label: "e*Message / Cityruf" },
  { group: "POCSAG pagers", flag: "🇩🇪", country: "Germany", mhz: 466.075, label: "e*Message / Cityruf" },
  { group: "POCSAG pagers", flag: "🇩🇪", country: "Germany", mhz: 466.23, label: "e*Message / Cityruf" },
  { group: "POCSAG pagers", flag: "🇩🇪", country: "Germany", mhz: 448.425, label: "e*Message / BOS" },
  { group: "POCSAG pagers", flag: "🇫🇷", country: "France", mhz: 466.025, label: "Alphapage" },
  { group: "POCSAG pagers", flag: "🇫🇷", country: "France", mhz: 466.175, label: "Alphapage" },
  { group: "POCSAG pagers", flag: "🇪🇺", country: "Europe", mhz: 439.9875, label: "DAPNET amateur" },
  { group: "POCSAG pagers", flag: "🇨🇦", country: "Canada", mhz: 929.2875, label: "PageNet" },
  // --- APRS / packet (AFSK1200 = AX.25) ------------------------------------
  { group: "APRS / packet (AFSK1200)", flag: "🇺🇸", country: "North America", mhz: 144.39, label: "APRS primary" },
  { group: "APRS / packet (AFSK1200)", flag: "🇪🇺", country: "Europe / UK", mhz: 144.8, label: "APRS primary" },
  { group: "APRS / packet (AFSK1200)", flag: "🇯🇵", country: "Japan", mhz: 144.66, label: "APRS primary" },
  { group: "APRS / packet (AFSK1200)", flag: "🇦🇺", country: "Australia", mhz: 145.175, label: "APRS primary" },
  { group: "APRS / packet (AFSK1200)", flag: "🇳🇿", country: "New Zealand", mhz: 144.575, label: "APRS primary" },
  { group: "APRS / packet (AFSK1200)", flag: "🇧🇷", country: "Brazil", mhz: 145.57, label: "APRS primary" },
  { group: "APRS / packet (AFSK1200)", flag: "🛰️", country: "ISS (worldwide)", mhz: 145.825, label: "ARISS digipeater" },
  // --- 9600-baud packet (FSK9600) ------------------------------------------
  { group: "Packet 9k6 (FSK9600)", flag: "🇯🇵", country: "Japan", mhz: 144.64, label: "APRS 9k6 GMSK" },
  // --- German BOS 4m band (FMSFSK status telegrams / ZVEI tone-out) ---------
  { group: "German BOS 4m (FMSFSK)", flag: "🇩🇪", country: "Germany", mhz: 84.015, label: "4m Oberband ch.347 (FMS/ZVEI)" },
  { group: "German BOS 4m (FMSFSK)", flag: "🇩🇪", country: "Germany", mhz: 85.095, label: "4m Oberband ch.401 (FMS/ZVEI)" },
  // --- NOAA Weather Radio (EAS / SAME) — 7 standard US channels -------------
  { group: "Weather radio (EAS / SAME)", flag: "🇺🇸", country: "USA", mhz: 162.4, label: "NOAA Weather Radio" },
  { group: "Weather radio (EAS / SAME)", flag: "🇺🇸", country: "USA", mhz: 162.425, label: "NOAA Weather Radio" },
  { group: "Weather radio (EAS / SAME)", flag: "🇺🇸", country: "USA", mhz: 162.45, label: "NOAA Weather Radio" },
  { group: "Weather radio (EAS / SAME)", flag: "🇺🇸", country: "USA", mhz: 162.475, label: "NOAA Weather Radio" },
  { group: "Weather radio (EAS / SAME)", flag: "🇺🇸", country: "USA", mhz: 162.5, label: "NOAA Weather Radio" },
  { group: "Weather radio (EAS / SAME)", flag: "🇺🇸", country: "USA", mhz: 162.525, label: "NOAA Weather Radio" },
  { group: "Weather radio (EAS / SAME)", flag: "🇺🇸", country: "USA", mhz: 162.55, label: "NOAA Weather Radio" },
  // --- X10 home-automation RF ----------------------------------------------
  { group: "Home automation (X10)", flag: "🇺🇸", country: "North America", mhz: 310.0, label: "X10 RF remotes" },
  { group: "Home automation (X10)", flag: "🇪🇺", country: "Europe", mhz: 433.92, label: "X10 RF remotes" },
  // --- CW beacons (MORSE_CW) -----------------------------------------------
  { group: "Beacons (MORSE_CW)", flag: "🌍", country: "Worldwide", mhz: 28.2, label: "NCDXF/IARU beacon" },
];

const sdr = new Sdr();
const waterfall = new Waterfall(els.wfwrap);
let worker: Worker | null = null;
let paired = false;
let streaming = false;
let usbUnsupported = false;
let pumpRunning = false;
let pumpPromise: Promise<void> | null = null;
let offsetHz = 0;
let packetCount = 0;
let active: { centerFrequency: number; sampleRate: number } | null = null;

// --- analytics stream bookkeeping (per Start→Stop cycle) ---------------------
let streamStartedAt = 0; // performance.now() at Start; 0 when not streaming
let streamPacketBase = 0; // packetCount when the stream started
const protocolsSeen = new Set<string>(); // protocols already reported this stream

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
// The shared status pill uses data-state; map our transient/on/err states onto
// its idle/connecting/running/error styling.
type StatusState = "idle" | "busy" | "on" | "err";
const STATUS_STATE: Record<StatusState, string> = {
  idle: "idle",
  busy: "connecting",
  on: "running",
  err: "error",
};
function setStatus(text: string, state: StatusState) {
  els.status.textContent = text;
  els.status.dataset.state = STATUS_STATE[state];
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

// Select device stays available (to swap dongles) but is locked mid-stream;
// Start needs a paired device and no active stream; Stop needs an active stream.
// The config controls (fields + demod checkboxes) are usable only once paired.
function updateButtons() {
  els.pair.disabled = usbUnsupported || streaming;
  els.start.disabled = usbUnsupported || !paired || streaming;
  els.stop.disabled = !streaming;
  setFieldsEnabled(!usbUnsupported && paired);
}

function setFieldsEnabled(enabled: boolean): void {
  for (const el of [els.preset, els.freq, els.rate, els.gain, els.fft, els.bw]) {
    el.disabled = !enabled;
  }
  document
    .querySelectorAll<HTMLInputElement>('.demods input[type="checkbox"]')
    .forEach((c) => (c.disabled = !enabled));
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
  // Report the first decode of each protocol per stream: which decoders
  // actually produce output, and the time-to-first-decode, without sending an
  // event per packet (busy pager channels would blow GA's event quota).
  if (streamStartedAt && !protocolsSeen.has(protocol)) {
    protocolsSeen.add(protocol);
    track("first_decode", {
      protocol,
      seconds_to_first: Math.round((performance.now() - streamStartedAt) / 1000),
    });
  }
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
      track("app_error", { context: "decoder", message: msg.message });
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
        track("app_error", { context: "usb_pump", message: String(e?.message ?? e) });
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
  setStatus("Pairing…", "busy");
  try {
    await sdr.pair();
    paired = true;
    setStatus("Paired — press Start", "idle");
    track("pair_success");
  } catch (e: any) {
    setStatus("Pairing cancelled", "idle");
    logLine(`pair: ${e?.message ?? e}`);
    track("pair_cancelled", { message: String(e?.message ?? e) });
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
    track("app_error", { context: "start", message: String(e?.message ?? e) });
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
    track("app_error", { context: "worker", message: e.message });
  };
  setStatus("Loading decoder…", "busy");
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
    streamStartedAt = performance.now();
    streamPacketBase = packetCount;
    protocolsSeen.clear();
    track("stream_start", {
      frequency_mhz: (selectedHz() / 1e6).toFixed(4),
      sample_rate: active!.sampleRate,
      gain: els.gain.value, // "auto" or a dB figure
      bandwidth_khz: Math.round(bandwidthHz() / 1000),
      demods: selectedDemods().join(",") || "(none)",
    });
  } catch {
    streaming = false;
  }
  updateButtons();
}

// Fires at most once per stream: on Stop, or on tab close mid-stream (gtag
// delivers via sendBeacon, which survives pagehide).
function trackStreamStop() {
  if (!streamStartedAt) return;
  track("stream_stop", {
    duration_seconds: Math.round((performance.now() - streamStartedAt) / 1000),
    packets_decoded: packetCount - streamPacketBase,
    protocols_decoded: protocolsSeen.size,
  });
  streamStartedAt = 0;
}
window.addEventListener("pagehide", trackStreamStop);

async function stopStream() {
  if (!streaming) return;
  streaming = false;
  els.stop.disabled = true;
  trackStreamStop();
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
  setStatus("Restarting…", "busy");
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
  let group: HTMLOptGroupElement | null = null;
  for (const p of PRESETS) {
    if (!group || group.label !== p.group) {
      group = document.createElement("optgroup");
      group.label = p.group;
      els.preset.appendChild(group);
    }
    const opt = document.createElement("option");
    opt.value = String(p.mhz);
    opt.textContent = `${p.flag} ${p.mhz.toFixed(4)} MHz · ${p.country} ${p.label}`;
    group.appendChild(opt);
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
  const p = PRESETS.find((p) => String(p.mhz) === v);
  track("preset_selected", {
    preset_mhz: v,
    preset_group: p?.group,
    preset_label: p ? `${p.country} ${p.label}` : undefined,
  });
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
    track("copy_command");
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
  usbUnsupported = true;
  // Which capability gate visitors bounce off: no WebUSB (Firefox/Safari) vs
  // Chromium too old for JSPI.
  track("unsupported_browser", {
    reason: "usb" in navigator ? "no_jspi" : "no_webusb",
  });
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
