import { PcmResampler } from './pcm.js';
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.resampler = new PcmResampler(sampleRate); }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const buffer of this.resampler.process(input)) this.port.postMessage(buffer, [buffer]);
    return true;
  }
}
registerProcessor('pcm-capture', CaptureProcessor);
