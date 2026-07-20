// Runs multimon-ng (compiled to WebAssembly with JSPI) inside the DSP worker,
// feeding it a continuous stream of signed-16-bit mono PCM audio pulled from an
// in-thread sample queue.
//
// multimon-ng reads "stdin" (the "-" input, raw S16 @ 22050 Hz); the wasm build
// replaces that blocking read() with a suspending host read (EM_ASYNC_JS ->
// Module.multimonReadStdin, see wasm/stdin-async.patch). JSPI suspends the wasm
// stack whenever the queue is empty and yields to the event loop, so the FFT,
// channelizer and message pump keep running even though multimon's main loop
// "never returns" — no second worker, no SharedArrayBuffer, no Atomics.

import type { SampleQueue } from "./sample-queue.ts";

export interface MultimonCallbacks {
  onPacket: (protocol: string, text: string) => void;
  onLog: (line: string) => void;
  onReady: () => void;
  onExit: (message: string) => void;
}

export interface MultimonHandle {
  /** Resolves when multimon-ng's main loop exits (after the queue is closed). */
  done: Promise<void>;
}

// A decoded line looks like "POCSAG1200: Address: 1234567 Function: 3 ...".
// The protocol tag is an all-caps token before the first colon; anything else
// (e.g. the "Enabled demodulators:" banner, warnings) is treated as a log line.
const PACKET_RE = /^([A-Z][A-Z0-9_]*):\s*(.*)$/;

export async function runMultimon(
  queue: SampleQueue,
  demods: string[],
  cb: MultimonCallbacks,
): Promise<MultimonHandle> {
  // The Emscripten build lives in /public and is served at the site root. Built
  // as a non-literal URL so the bundler treats it as a runtime asset.
  const glueUrl = new URL("/multimon.js", location.origin).href;
  const createMultimon = (await import(/* @vite-ignore */ glueUrl)).default as (
    opts: Record<string, unknown>,
  ) => Promise<any>;

  const mod = await createMultimon({
    noInitialRun: true,
    // Called from wasm (EM_ASYNC_JS) for each input block: hand it up to `len`
    // bytes of S16 audio, suspending until some are available.
    multimonReadStdin: (len: number) => queue.read(len),
    print: (line: string) => {
      const s = line.trimEnd();
      if (!s) return;
      const m = PACKET_RE.exec(s);
      if (m) cb.onPacket(m[1], m[2]);
      else cb.onLog(s);
    },
    printErr: (line: string) => {
      if (line.trim()) cb.onLog(line);
    },
  });

  cb.onReady();

  // -t raw : read raw S16LE mono (multimon's demods fix the rate at 22050 Hz)
  // -a ... : enable each requested demodulator
  // -q     : suppress the startup banner and per-line noise
  // -      : read from stdin (our live audio stream)
  const args = ["-t", "raw", "-q"];
  for (const d of demods) args.push("-a", d);
  args.push("-");

  // Under JSPI, callMain returns a Promise that resolves when main() returns —
  // which for us happens only once the queue is closed (read -> EOF).
  const done = Promise.resolve(mod.callMain(args))
    .then((code: number) => {
      cb.onExit(code ? `multimon-ng exited with code ${code}` : "stopped");
    })
    .catch((e: any) => {
      cb.onExit(`multimon-ng error: ${e?.message ?? e}`);
    });

  return { done };
}
