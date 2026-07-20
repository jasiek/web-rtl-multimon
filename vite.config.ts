import { defineConfig } from "vite";

// No cross-origin isolation needed. The heavy signal chain (FFT for the
// waterfall, the channelizer/FM-demod, and multimon-ng itself) runs inside a
// single Web Worker. multimon-ng is built with JSPI, so its stdin read suspends
// the wasm stack on a Promise instead of blocking a thread with Atomics -- so
// there is no SharedArrayBuffer and no need for COOP/COEP. The site therefore
// works on any static host (e.g. GitHub Pages) with no header configuration.
export default defineConfig({
  // rtlsdrjs is a CommonJS package, vendored (symlinked) outside node_modules.
  // Force CJS interop for it in both dev (esbuild prebundle) and build (Rollup).
  optimizeDeps: {
    include: ["rtlsdrjs"],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /vendor[\\/]rtlsdrjs/],
      transformMixedEsModules: true,
    },
  },
  worker: {
    format: "es",
  },
});
