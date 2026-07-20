#!/usr/bin/env bash
# Compile upstream multimon-ng (vendor/multimon-ng) to WebAssembly.
#
# Output: public/multimon.js + public/multimon.wasm  (Emscripten ES module, no
# auto-run). The worker drives main() via callMain() and feeds it a live stream
# of signed-16-bit mono PCM audio (22050 Hz) on "stdin".
#
# multimon-ng is a flat list of .c files, so we invoke emcc directly rather than
# going through its CMakeLists (which does host feature-detection we don't want
# under Emscripten). We disable every host I/O backend -- audio devices (OSS/
# PulseAudio/CoreAudio), X11 scope, SDL scope, and the sox fork path (ONLY_RAW)
# -- leaving only the raw stdin reader, which our patch makes async/suspending.
#
# Requires the Emscripten SDK, pinned in .tool-versions and managed by asdf
# (`asdf install emsdk`). Set EMSDK to use a manual checkout instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/vendor/multimon-ng"
OUT="$ROOT/public"

# --- locate Emscripten -------------------------------------------------------
# Resolve the emsdk install (asdf-managed by default, else a manual $EMSDK) and
# source its env so the real emcc (and its matching wasm-ld) lead on PATH. emcc
# shells out to python, so EMSDK_PYTHON must point at the SDK's interpreter.
EMSDK_HOME="${EMSDK:-}"
if [[ -z "$EMSDK_HOME" ]] && command -v asdf >/dev/null 2>&1; then
  EMSDK_HOME="$(asdf where emsdk 2>/dev/null || true)"
fi
if [[ -n "$EMSDK_HOME" ]]; then
  if [[ -z "${EMSDK_PYTHON:-}" ]]; then
    EMSDK_PYTHON="$(ls -d "$EMSDK_HOME"/python/*/bin/python3 2>/dev/null | head -1 || true)"
    [[ -n "$EMSDK_PYTHON" ]] && export EMSDK_PYTHON
  fi
  if [[ -f "$EMSDK_HOME/emsdk_env.sh" ]]; then
    # shellcheck disable=SC1091
    source "$EMSDK_HOME/emsdk_env.sh" >/dev/null 2>&1
  fi
fi
command -v emcc >/dev/null 2>&1 || { echo "error: emcc not found. Run 'asdf install emsdk' (version pinned in .tool-versions) or set EMSDK." >&2; exit 1; }
echo "Using $(emcc --version 2>/dev/null | head -1)"

mkdir -p "$OUT"

# --- apply the async-stdin patch to the vendored submodule -------------------
# Replaces the blocking read() on fd 0 with a suspending host read so the
# decoder runs with no SharedArrayBuffer (see the patch header and
# src/worker/multimon.ts). Idempotent: skipped if already applied.
PATCH="$ROOT/wasm/stdin-async.patch"
if [[ -f "$PATCH" ]]; then
  if git -C "$SRC" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
    echo "async-stdin patch already applied"
  else
    echo "applying async-stdin patch"
    git -C "$SRC" apply "$PATCH"
  fi
fi

# --- sources -----------------------------------------------------------------
# The decoder core + every demodulator, minus the host-audio, scope, and signal
# generator sources. Mirrors the multimon-ng target's SOURCES list.
SOURCES=(
  unixinput.c uart.c pocsag.c selcall.c hdlc.c fms.c clip.c
  costabi.c costabf.c cJSON.c bch.c
  demod_poc5.c demod_poc12.c demod_poc24.c
  demod_flex.c demod_flex_next.c demod_gsc.c
  demod_afsk12.c demod_afsk24.c demod_afsk24_2.c demod_afsk24_3.c
  demod_hapn48.c demod_fsk96.c demod_ufsk12.c demod_clipfsk.c demod_fmsfsk.c
  demod_dtmf.c demod_zvei1.c demod_zvei2.c demod_zvei3.c demod_pzvei.c
  demod_dzvei.c demod_ccir.c demod_eia.c demod_eea.c demod_eas.c
  demod_morse.c demod_dumpcsv.c demod_x10.c
)

# --- compile flags -----------------------------------------------------------
# DUMMY_AUDIO   : no live audio device (we feed stdin instead)
# NO_X11 NO_SDL3: no display scope backends
# ONLY_RAW      : drop the sox fork/exec path (no fork() in wasm)
# HAVE_TIMESPEC_GET: use Emscripten/musl's timespec_get, not the static fallback
CFLAGS=(
  -std=gnu11 -O2
  -DDUMMY_AUDIO -DNO_X11 -DNO_SDL3 -DONLY_RAW
  -DCHARSET_UTF8 -DMAX_VERBOSE_LEVEL=3 -DHAVE_TIMESPEC_GET
  -Wno-unused-parameter -Wno-unused-result
)

# --- link flags --------------------------------------------------------------
# We drive main() ourselves via callMain(); stdin is a live async audio stream
# (JSPI suspends the read), stdout carries decoded packet lines.
LDFLAGS=(
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createMultimon
  -sINVOKE_RUN=0
  -sEXIT_RUNTIME=0
  -sALLOW_MEMORY_GROWTH=1
  -sJSPI
  -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,HEAPU8
  -sENVIRONMENT=web,worker
)

echo "Compiling multimon-ng -> wasm (${#SOURCES[@]} sources)…"
( cd "$SRC" && emcc "${CFLAGS[@]}" "${SOURCES[@]}" "${LDFLAGS[@]}" \
    -o "$OUT/multimon.js" )

echo "wrote $OUT/multimon.js and $OUT/multimon.wasm"
