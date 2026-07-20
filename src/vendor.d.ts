// rtlsdrjs is plain CommonJS without types. The `browser` field in its
// package.json swaps the libusb backend for a WebUSB one automatically.
declare module "rtlsdrjs" {
  export interface RtlSdrDevice {
    open(opts?: { ppm?: number; gain?: number }): Promise<void>;
    setSampleRate(rate: number): Promise<number>;
    setCenterFrequency(freq: number): Promise<number>;
    resetBuffer(): Promise<void>;
    readSamples(count: number): Promise<ArrayBuffer>;
    close(): Promise<void>;
  }
  const RtlSdr: {
    requestDevice(): Promise<RtlSdrDevice>;
    getDevices(): Promise<RtlSdrDevice[]>;
  };
  export default RtlSdr;
}
