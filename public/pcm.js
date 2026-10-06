// Stateful box-filter resampling keeps frame boundaries continuous.
export class PcmResampler {
  constructor(inputRate, outputRate = 16000, chunkSize = 512) {
    if (inputRate < outputRate) throw new Error('Taxa de captura não suportada.');
    this.ratio = inputRate / outputRate; this.chunkSize = chunkSize;
    this.weight = 0; this.sum = 0; this.samples = [];
  }
  process(input) {
    const chunks = [];
    for (const sample of input) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take; this.weight += take; remaining -= take;
        if (this.weight >= this.ratio - 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.samples.push(Math.round(value * (value < 0 ? 32768 : 32767)));
          this.sum = 0; this.weight = 0;
          if (this.samples.length === this.chunkSize) {
            const buffer = new ArrayBuffer(this.chunkSize * 2); const view = new DataView(buffer);
            this.samples.forEach((v, i) => view.setInt16(i * 2, v, true));
            chunks.push(buffer); this.samples = [];
          }
        }
      }
    }
    return chunks;
  }
}
export function decodePcm(buffer) {
  if (buffer.byteLength % 2) throw new Error('PCM inválido.');
  const view = new DataView(buffer); const result = new Float32Array(buffer.byteLength / 2);
  for (let i = 0; i < result.length; i++) result[i] = view.getInt16(i * 2, true) / 32768;
  return result;
}
