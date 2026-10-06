// Nível RMS (0 a 1) acima do qual um chunk de 32 ms conta como fala.
export const VOICE_THRESHOLD = 0.02;
export function voiceLevel(buffer) {
  const view = new DataView(buffer); const count = buffer.byteLength / 2;
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) { const v = view.getInt16(i * 2, true) / 32768; sum += v * v; }
  return Math.sqrt(sum / count);
}
const SOURCES = ['perceived', 'model'];
function percentile(sorted, p) { return sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)]; }
export class LatencyLog {
  constructor() { this.values = Object.fromEntries(SOURCES.map(s => [s, []])); }
  add(source, ms) {
    if (!SOURCES.includes(source)) throw new Error(`Fonte de latência inválida: ${source}`);
    this.values[source].push(ms);
  }
  summary(source) {
    const values = this.values[source];
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return { count: values.length, last: values.at(-1), p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
  }
}
export function formatLatency(label, s) {
  if (!s) return `${label}: aguardando primeira resposta`;
  return `${label}: última ${s.last} ms · p50 ${s.p50} ms · p95 ${s.p95} ms · ${s.count} ${s.count === 1 ? 'turno' : 'turnos'}`;
}
