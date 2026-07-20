# web-rtl-multimon

Decode POCSAG / FLEX pagers, AFSK, tone/selcall and more, straight from an
[RTL-SDR](https://www.rtl-sdr.com/) USB dongle **in your browser** — no native
install. It connects to the dongle over **WebUSB**, shows a live **waterfall**,
lets you **click to pick a channel**, FM-demodulates that channel to audio in the
browser, and feeds it to the real [`multimon-ng`](https://github.com/EliasOenal/multimon-ng)
decoder compiled to **WebAssembly**.

## How it works

```
 ┌───────────┐ WebUSB  ┌── main thread ───────────────┐   ┌── DSP worker ──────────────────────────────┐
 │  RTL-SDR  │ ──────▶ │  rtlsdrjs pump               │   │                                            │
 │ (RTL2832U)│  CU8 IQ │  ─cu8 blocks (transferred)──▶│──▶│  Fft ───────────▶ waterfall column ──┐     │
 └───────────┘         │  waterfall canvas ◀──────────│◀──│                                      │     │
                       │  click-to-tune ──offset──────│──▶│  Channelizer (NCO mix ↓ FIR ↓ FIR    │     │
                       │  packet table  ◀─────────────│◀──│    ↓ FM discriminator) ─S16 audio─┐   │     │
                       └──────────────────────────────┘   │                                  ▼   │     │
                                                          │            SampleQueue ─▶ multimon-ng.wasm │
                                                          │                       (JSPI suspend) ──────┘
                                                          └────────────────────────────────────────────┘
```

WebUSB only works on the main thread, so the page captures raw CU8 IQ there and
**transfers** each block to a single Web Worker that owns the whole signal chain:

- **Waterfall:** a small radix-2 FFT (`src/worker/fft.ts`) turns each IQ block
  into one spectrogram column spanning the full tuned bandwidth. Click anywhere
  on it to set the decode channel.
- **Channelizer + FM demod:** `src/worker/channelizer.ts` mixes the selected
  offset down to baseband with an NCO, low-pass filters and decimates it in two
  stages to exactly **22050 Hz**, then runs an FM discriminator to recover audio
  — the same thing `rtl_fm` would hand to `multimon-ng` on the command line.
- **Decode:** upstream `multimon-ng` is built with Emscripten (audio devices,
  X11/SDL scope and the `sox` fork path all disabled) **plus JSPI** (`-sJSPI`).
  A small patch (`wasm/stdin-async.patch`) replaces the blocking `read()` on
  stdin with a suspending host read: when the audio queue is empty the wasm
  stack suspends and yields to the event loop (so the FFT, demod and UI keep
  running), then resumes when the next audio arrives. Decoded packet lines come
  back on stdout and render into the table.

No `SharedArrayBuffer`, no cross-origin isolation: because multimon-ng suspends
on each stdin read (JSPI) and the audio hand-off is a plain in-worker queue,
there's no `COOP`/`COEP` and the site works on any static host over HTTPS.

## Requirements

- A **Chromium-based browser** (Chrome / Edge 137+) — needs both WebUSB and
  WebAssembly **JSPI** (stack switching). Not available in Firefox/Safari.
- An RTL-SDR (RTL2832U) dongle, e.g. RTL-SDR Blog v3/v4.
- On Linux you may need a udev rule / to detach the `dvb_usb_rtl28xxu` kernel
  module so the browser can claim the device.

## Setup

```bash
git clone --recurse-submodules <this repo>
cd web-rtl-multimon
npm install

# Build multimon-ng -> WebAssembly (needs the Emscripten SDK; either have `emcc`
# on PATH or set EMSDK to your emsdk checkout):
npm run build:wasm

npm run dev          # open the printed localhost URL
```

Click **Pair device** once and choose your dongle in the browser prompt — after
that the browser remembers it, so **Start** / **Stop** never prompt again. Set
the **center frequency** to a band with pager traffic (see below), pick a
**sample rate** (the waterfall span), and press **Start**. When the waterfall
lights up, **click a signal** to point the green channel marker at it; decoded
packets stream into the table. **Scroll** to zoom the waterfall in on a channel
(centered on the cursor) and **middle-button drag** to pan the zoomed view.

Every setting applies live while running — no reconnect: frequency and the
waterfall marker retune instantly; channel width, FFT size and demodulator
selection restart just the decoder; sample rate and gain do a quick, silent
stream restart. **Stop** releases the dongle (it stays paired for next time).

### Where to listen

Pager and data activity varies by region. Common starting points:

- **VHF pagers (POCSAG/FLEX):** ~137–169 MHz (check your local allocations).
- **929–932 MHz:** FLEX/POCSAG paging in North America.
- **AFSK1200:** 144.800 MHz (APRS, EU) / 144.390 MHz (APRS, NA).

The default channel width (7.5 kHz) suits narrowband FM pagers; widen it for
signals that occupy more spectrum.

## Deploy to GitHub Pages

The repo ships a workflow (`.github/workflows/deploy.yml`) that builds the wasm
with Emscripten in CI and publishes `dist/` to Pages:

1. **Push the repo to GitHub.**
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Custom domain:** configured for `web-rtl-multimon.jasiek.me` via
   `public/CNAME`. Add a DNS record in the `jasiek.me` zone:
   ```
   CNAME   web-rtl-multimon   <your-github-username>.github.io
   ```
   Then set the custom domain in Settings → Pages and enable **Enforce HTTPS**
   (WebUSB requires HTTPS).
4. Push to `main`/`master` — the Action builds and deploys automatically.

**No special headers needed:** with no `SharedArrayBuffer` there's no `COOP`/
`COEP` requirement, so it works on GitHub Pages (or any static host) as-is —
just serve over HTTPS for WebUSB.

## Layout

| Path                        | What                                                             |
| --------------------------- | --------------------------------------------------------------- |
| `wasm/build.sh`             | Compiles `vendor/multimon-ng` to `public/multimon.{js,wasm}` (JSPI) |
| `wasm/stdin-async.patch`    | Makes multimon-ng's stdin read suspend instead of blocking       |
| `src/sdr.ts`                | WebUSB sample pump (wraps `rtlsdrjs`)                             |
| `src/waterfall.ts`          | Scrolling waterfall canvas + click-to-tune                       |
| `src/main.ts`               | UI + lifecycle; wires SDR → worker → table                       |
| `src/worker/dsp-worker.ts`  | Owns the signal chain off the main thread                        |
| `src/worker/fft.ts`         | Radix-2 FFT for the waterfall                                    |
| `src/worker/channelizer.ts` | NCO mix + decimating FIRs + FM discriminator → S16 audio         |
| `src/worker/sample-queue.ts`| In-worker async byte queue (audio → decoder)                     |
| `src/worker/multimon.ts`    | Loads the wasm, feeds it audio, surfaces decoded lines           |
| `vendor/multimon-ng`        | upstream decoder (submodule)                                     |
| `vendor/rtlsdrjs`           | WebUSB RTL2832U driver (vendored)                                |

## Credits

Built on [`multimon-ng`](https://github.com/EliasOenal/multimon-ng) by Elias
Oenal & contributors (itself descended from Thomas Sailer's `multimon`), and
[`rtlsdrjs`](https://github.com/sandeepmistry/rtlsdrjs) by Sandeep Mistry.
