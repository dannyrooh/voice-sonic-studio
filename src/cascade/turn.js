import { voiceLevel, VOICE_THRESHOLD } from '../../public/metrics.js';

// Silêncio no microfone que encerra o turno, por opção de "Espera entre turnos".
export const ENDPOINT_MS = { HIGH: 400, MEDIUM: 700, LOW: 1100 };

// O final do Transcribe chega ~1,5 s após a fala; o turno termina antes, por silêncio e texto parcial estável.
export class TurnDetector {
  constructor(endpointMs, settleMs = 250) { this.endpointMs = endpointMs; this.settleMs = settleMs; this.answered = new Map(); this.clear(); }
  clear() { this.segments = new Map(); this.full = new Map(); this.lastVoiceAt = null; this.lastTextAt = null; }
  audio(bytes, now) {
    const voiced = voiceLevel(Uint8Array.from(bytes).buffer) >= VOICE_THRESHOLD;
    if (voiced) this.lastVoiceAt = now;
    return voiced;
  }
  transcript(id, text, now) {
    // Mesma tokenização para contar e fatiar; tokens sem letra ou número (travessão solto) não contam.
    const words = value => value.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));
    let fresh = text;
    if (this.answered.has(id)) {
      // Fala retomada dentro de um ResultId já respondido: só as palavras novas no fim contam.
      fresh = words(text).slice(words(this.answered.get(id)).length).join(' ');
      if (!fresh.trim()) return false;
    }
    this.segments.set(id, fresh); this.full.set(id, text); this.lastTextAt = now;
    return true;
  }
  get text() { return [...this.segments.values()].join(' ').trim(); }
  poll(now) {
    const text = this.text;
    if (!text) return null;
    const silenceSince = this.lastVoiceAt ?? this.lastTextAt;
    if (now - silenceSince < this.endpointMs || now - this.lastTextAt < this.settleMs) return null;
    for (const id of this.segments.keys()) this.answered.set(id, this.full.get(id));
    this.clear();
    return text;
  }
}

// Agrupa o texto do LLM em frases para o Polly começar a falar antes do fim da resposta.
export class SentenceChunker {
  constructor(minChars = 12) { this.minChars = minChars; this.buffer = ''; }
  push(delta) {
    this.buffer += delta;
    const sentences = []; const boundary = /[.!?…;:]+["')\]]?\s+/g; let cut = 0; let match;
    while ((match = boundary.exec(this.buffer))) {
      const end = match.index + match[0].length;
      if (end - cut >= this.minChars) { sentences.push(this.buffer.slice(cut, end)); cut = end; }
    }
    this.buffer = this.buffer.slice(cut);
    return sentences;
  }
  flush() { const rest = this.buffer; this.buffer = ''; return rest.trim() ? [rest] : []; }
}

// O navegador rejeita PCM com número ímpar de bytes; guarda o byte que sobra para o próximo chunk.
export class PcmAligner {
  constructor() { this.rest = null; }
  push(chunk) {
    let bytes = Buffer.from(chunk);
    if (this.rest) { bytes = Buffer.concat([this.rest, bytes]); this.rest = null; }
    if (bytes.length % 2) { this.rest = bytes.subarray(-1); bytes = bytes.subarray(0, -1); }
    return bytes;
  }
}
