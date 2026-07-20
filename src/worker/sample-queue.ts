// A single-threaded async byte queue connecting the SDR sample pump (producer)
// to the rtl_433 wasm decoder (consumer), both running on the main thread.
//
// Replaces the old SharedArrayBuffer + Atomics ring buffer: because the wasm is
// built with JSPI, its stdin read can suspend on a Promise instead of blocking a
// worker thread with Atomics.wait. So no SharedArrayBuffer, no cross-origin
// isolation, and no Web Worker are needed -- a plain in-thread queue suffices.
//
// The consumer calls read(len); if bytes are buffered it gets them synchronously,
// otherwise it gets a Promise that resolves on the next push() (or on close(),
// which resolves empty to signal EOF). The producer never blocks: if the consumer
// falls behind and the queue exceeds its cap, the oldest chunks are dropped and
// an overflow counter is bumped -- matching the old ring's drop-on-overflow.

const EMPTY = new Uint8Array(0);

export class SampleQueue {
  private chunks: Uint8Array[] = [];
  private queued = 0; // bytes currently buffered across chunks
  private waiter: { len: number; resolve: (b: Uint8Array) => void } | null = null;
  private closed = false;
  private overflow = 0;

  constructor(private readonly cap: number) {}

  /**
   * Producer: enqueue a chunk. The SDR reuses its read buffer, so we copy to own
   * the bytes. Drops oldest chunks (counting an overflow) if we exceed the cap.
   */
  push(bytes: Uint8Array): void {
    if (this.closed || bytes.length === 0) return;
    this.chunks.push(bytes.slice());
    this.queued += bytes.length;
    while (this.queued > this.cap && this.chunks.length > 1) {
      this.queued -= this.chunks.shift()!.length;
      this.overflow++;
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(this.take(w.len));
    }
  }

  /**
   * Consumer (driven from wasm): up to `len` bytes, waiting until some are
   * available. Resolves empty once the queue is closed and drained -> EOF.
   */
  read(len: number): Uint8Array | Promise<Uint8Array> {
    if (this.queued > 0) return this.take(len);
    if (this.closed) return EMPTY;
    return new Promise<Uint8Array>((resolve) => {
      this.waiter = { len, resolve };
    });
  }

  /** Pull up to `len` bytes off the front. Always returns 1..len bytes. */
  private take(len: number): Uint8Array {
    const head = this.chunks[0];
    if (head.length <= len) {
      this.chunks.shift();
      this.queued -= head.length;
      return head;
    }
    // Head is bigger than the request: hand back a prefix, keep the remainder.
    const out = head.subarray(0, len);
    this.chunks[0] = head.subarray(len);
    this.queued -= len;
    return out;
  }

  /** Signal EOF: wakes a parked reader with an empty buffer (stops rtl_433). */
  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(EMPTY);
    }
  }

  overflows(): number {
    return this.overflow;
  }
}
