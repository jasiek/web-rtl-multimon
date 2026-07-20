// Thin wrapper around rtlsdrjs: request an RTL-SDR over WebUSB, tune it, and
// pump raw CU8 IQ samples into the sample queue for the in-thread decoder.
import RtlSdr from "rtlsdrjs";
import type { RtlSdrDevice } from "rtlsdrjs";

/** Where pumped samples go: satisfied by SampleQueue. */
export interface SampleSink {
  push(bytes: Uint8Array): void;
  overflows(): number;
}

export interface SdrOptions {
  centerFrequency: number; // Hz
  sampleRate: number; // Hz
  gain?: number; // dB; omit for auto gain
  ppm?: number;
}

// Samples requested per WebUSB bulk read. 16384 IQ pairs == 32 KiB, a good
// balance between USB overhead and latency at 250 kHz.
const SAMPLES_PER_READ = 16 * 1024;

// How many back-to-back USB read failures to tolerate before giving up. A
// handful of transient transferIn errors is normal; sustained failure is not.
const MAX_CONSECUTIVE_USB_ERRORS = 10;

// How long to keep trying to re-acquire the dongle after it drops off the bus
// (e.g. it faulted on an ESD spike from the antenna or a thermal glitch and
// re-enumerated as a fresh USB device), and how often to poll for it.
const REATTACH_TIMEOUT_MS = 15_000;
const REATTACH_POLL_MS = 250;

export class Sdr {
  private device: RtlSdrDevice | null = null;
  private running = false;
  // Remembered so we can re-open and re-tune a re-enumerated dongle without a
  // user gesture (only requestDevice() needs one; open()/getDevices() do not).
  private opts: SdrOptions | null = null;

  /** Optional tap on the raw CU8 stream, used for diagnostic recording. */
  onSamples: ((bytes: Uint8Array) => void) | undefined;

  /**
   * One-time pairing: prompt the WebUSB chooser (requires a user gesture) so the
   * browser authorizes this dongle. Afterwards getDevices() returns it silently,
   * so start()/stop() can open and close it without ever prompting again.
   */
  async pair(): Promise<void> {
    await RtlSdr.requestDevice(); // throws if the user cancels the chooser
  }

  /** True if a dongle has already been authorized (this session or a prior one). */
  async isPaired(): Promise<boolean> {
    return (await RtlSdr.getDevices()).length > 0;
  }

  /**
   * Open the already-paired dongle and apply tuning. No user gesture needed:
   * it re-acquires the authorized device via getDevices(). Throws if nothing has
   * been paired yet.
   */
  async start(opts: SdrOptions): Promise<{ sampleRate: number; centerFrequency: number }> {
    this.opts = opts;
    const [device] = await RtlSdr.getDevices();
    if (!device) throw new Error("No paired RTL-SDR — click ‘Pair device’ first.");
    return this.openAndTune(device);
  }

  // Open a freshly-acquired device and apply the remembered tuning. On success
  // it becomes the active device; on failure the caller owns the rollback.
  private async openAndTune(
    device: RtlSdrDevice,
  ): Promise<{ sampleRate: number; centerFrequency: number }> {
    const opts = this.opts!;
    await device.open({ ppm: opts.ppm ?? 0, ...(opts.gain != null ? { gain: opts.gain } : {}) });
    const sampleRate = await device.setSampleRate(opts.sampleRate);
    const centerFrequency = await device.setCenterFrequency(opts.centerFrequency);
    await device.resetBuffer();
    this.device = device;
    return { sampleRate, centerFrequency };
  }

  // Recover from a USB re-enumeration. The handle we held is permanently dead,
  // so drop it and poll navigator.usb.getDevices() (no user gesture required)
  // for the dongle to reappear, then re-open and re-tune it. Returns false if
  // it never comes back within the timeout. Assumes a single RTL-SDR.
  private async reattach(onWarn?: (message: string) => void): Promise<boolean> {
    const dead = this.device;
    this.device = null;
    await dead?.close().catch(() => {});

    const deadline = Date.now() + REATTACH_TIMEOUT_MS;
    let attempt = 0;
    while (this.running && Date.now() < deadline) {
      attempt++;
      const [device] = await RtlSdr.getDevices().catch(() => []);
      if (device) {
        try {
          const a = await this.openAndTune(device);
          onWarn?.(
            `re-attached after ${attempt} attempt(s): ` +
              `${(a.centerFrequency / 1e6).toFixed(3)} MHz @ ${(a.sampleRate / 1e3).toFixed(0)} kHz`,
          );
          return true;
        } catch {
          // Device is enumerating but not ready to open/tune yet — roll back
          // the partial open and keep polling.
          await device.close().catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, REATTACH_POLL_MS));
    }
    return false;
  }

  /** Continuously read samples and feed them to the sample queue until stopped. */
  async pump(
    sink: SampleSink,
    onOverflow?: (count: number) => void,
    onWarn?: (message: string) => void,
  ): Promise<void> {
    if (!this.device) throw new Error("SDR not connected");
    this.running = true;
    let lastOverflow = 0;
    let consecutiveErrors = 0;
    while (this.running) {
      const device = this.device;
      if (!device) throw new Error("SDR not connected");
      let buf: ArrayBuffer;
      try {
        buf = await device.readSamples(SAMPLES_PER_READ);
        consecutiveErrors = 0;
      } catch (e: any) {
        if (!this.running) break;
        const msg = e?.message ?? String(e);
        // A real USB disconnect means the dongle dropped off the bus and
        // re-enumerated as a fresh device — the handle is dead and no amount
        // of resetBuffer() revives it. Re-acquire and re-tune it instead.
        if (/disconnect/i.test(msg)) {
          onWarn?.(`device disconnected (re-enumerated); auto re-attaching…`);
          const ok = await this.reattach(onWarn);
          if (!this.running) break;
          if (!ok) throw new Error(`re-attach timed out after ${REATTACH_TIMEOUT_MS / 1000}s: ${msg}`);
          consecutiveErrors = 0;
          continue;
        }
        // Otherwise a transient transferIn hiccup: reset and retry a few times,
        // giving up only if they persist (which points at a real problem).
        consecutiveErrors++;
        if (consecutiveErrors > MAX_CONSECUTIVE_USB_ERRORS) throw e;
        onWarn?.(`USB read error (retry ${consecutiveErrors}): ${msg}`);
        await device.resetBuffer().catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      if (!this.running) break;
      const bytes = new Uint8Array(buf);
      sink.push(bytes);
      this.onSamples?.(bytes);
      const o = sink.overflows();
      if (o !== lastOverflow) {
        lastOverflow = o;
        onOverflow?.(o);
      }
    }
  }

  async setCenterFrequency(freq: number): Promise<number> {
    if (!this.device) throw new Error("SDR not connected");
    return this.device.setCenterFrequency(freq);
  }

  async resetBuffer(): Promise<void> {
    if (!this.device) throw new Error("SDR not connected");
    return this.device.resetBuffer();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.device) {
      await this.device.close().catch(() => {});
      this.device = null;
    }
  }

  get connected(): boolean {
    return this.device !== null;
  }
}
