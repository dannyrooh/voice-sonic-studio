import { EventQueue, systemText } from '../sonic.js';
import { ValidationError } from '../config.js';
import { TurnDetector, SentenceChunker, PcmAligner, ENDPOINT_MS } from './turn.js';

const MAX_MESSAGES = 20;
const SPOKEN_OUTPUT = '\nSuas respostas serão faladas em voz alta: use frases curtas, sem markdown, listas, emojis ou URLs.';

export class CascadeSession {
  constructor(config, send, adapters, { now = () => performance.now(), pollMs = 50, turnTimeoutMs = 30000 } = {}) {
    this.config = config; this.send = send; this.adapters = adapters; this.now = now; this.pollMs = pollMs; this.turnTimeoutMs = turnTimeoutMs;
    this.audioQueue = new EventQueue(); this.controller = new AbortController();
    this.detector = new TurnDetector(ENDPOINT_MS[config.conversation.endpointingSensitivity]);
    this.history = []; this.turn = null; this.pending = null; this.turns = 0; this.playbackUntil = 0;
    this.usage = { inputTokens: 0, outputTokens: 0, ttsCharacters: 0 };
    this.closed = false; this.error = null;
  }
  async start() {
    this.timer = setInterval(() => this.poll(), this.pollMs); this.timer.unref?.();
    this.send({ type: 'ready' });
    try {
      for await (const result of this.adapters.transcribe(this.audioQueue, this.config.conversation.language, this.controller.signal)) {
        if (this.closed) break;
        const fresh = this.detector.transcript(result.id, result.text, this.now());
        // Interrompe durante a geração ou enquanto o áudio já enviado ainda deve estar tocando.
        if (fresh && this.config.conversation.allowInterruption && (this.turn || this.now() < this.playbackUntil)) this.interrupt();
      }
    } catch (error) { throw this.error || error; }
    finally { clearInterval(this.timer); }
    if (this.error) throw this.error;
  }
  audio(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length % 2 || bytes.length > 8192) throw new ValidationError('Chunk PCM inválido.');
    if (this.closed) return;
    this.detector.audio(bytes, this.now());
    this.audioQueue.push(bytes);
  }
  poll() {
    if (this.closed || this.turn) return;
    const text = this.detector.poll(this.now());
    if (text) this.pending = this.respond(text).catch(error => this.fail(error));
  }
  interrupt() {
    this.turn?.controller.abort(); this.playbackUntil = 0;
    this.send({ type: 'interrupted' });
  }
  // Converse exige alternância user/assistant começando por user.
  addMessage(role, text) {
    const last = this.history.at(-1);
    if (last?.role === role) last.content[0].text += ` ${text}`;
    else this.history.push({ role, content: [{ text }] });
    while (this.history.length > MAX_MESSAGES || this.history[0]?.role === 'assistant') this.history.shift();
  }
  async respond(text) {
    const n = ++this.turns;
    const turn = { controller: new AbortController(), startedAt: this.now(), text: '', stages: {}, firstSentenceAt: null, failure: null };
    this.turn = turn;
    const signal = AbortSignal.any([this.controller.signal, turn.controller.signal]);
    this.send({ type: 'transcript', id: `turn-${n}-user`, role: 'USER', text });
    this.addMessage('user', text);
    const sentences = new EventQueue();
    // Bedrock ou Polly travados sem erro derrubariam a conversa em silêncio: o turno vira falha visível.
    const timeout = setTimeout(() => { turn.failure ??= new Error(`A resposta demorou mais de ${Math.round(this.turnTimeoutMs / 1000)} s. Verifique o modelo e a conexão com os serviços e inicie outra conversa.`); turn.controller.abort(); }, this.turnTimeoutMs);
    timeout.unref?.();
    try {
      // A voz abre a conexão junto com o Bedrock para o handshake não somar à latência.
      await Promise.allSettled([this.generate(turn, n, sentences, signal), this.speak(turn, sentences, signal)]);
      if (turn.failure) throw turn.failure;
    } finally {
      clearTimeout(timeout);
      if (turn.text.trim()) this.addMessage('assistant', turn.text.trim());
      if (this.turn === turn) this.turn = null;
      this.send({ type: 'usage', ...this.usage });
    }
  }
  failTurn(turn, signal, error) {
    if (!signal.aborted) { turn.failure ??= error; turn.controller.abort(); }
    throw error;
  }
  async generate(turn, n, sentences, signal) {
    const chunker = new SentenceChunker();
    const queue = sentence => { turn.firstSentenceAt ??= this.now(); sentences.push(sentence); };
    try {
      const request = { modelId: this.config.cascade.llmModelId, system: systemText(this.config) + SPOKEN_OUTPUT, messages: structuredClone(this.history), conversation: this.config.conversation };
      for await (const part of this.adapters.reply(request, signal)) {
        if (signal.aborted) break;
        if (part.usage) { this.usage.inputTokens += part.usage.inputTokens ?? 0; this.usage.outputTokens += part.usage.outputTokens ?? 0; continue; }
        turn.stages.llm ??= Math.round(this.now() - turn.startedAt);
        turn.text += part.text;
        this.send({ type: 'transcript', id: `turn-${n}-assistant`, role: 'ASSISTANT', text: part.text });
        chunker.push(part.text).forEach(queue);
      }
      if (!signal.aborted) chunker.flush().forEach(queue);
    } catch (error) { this.failTurn(turn, signal, error); }
    finally { sentences.close(); }
  }
  async speak(turn, sentences, signal) {
    const aligner = new PcmAligner();
    try {
      const voiceId = this.config.pipeline === 'elevenlabs' ? this.config.cascade.elevenVoiceId : this.config.cascade.pollyVoiceId;
      for await (const part of this.adapters.speak(sentences, voiceId, signal)) {
        if (signal.aborted) break;
        if (part.characters !== undefined) { this.usage.ttsCharacters += part.characters; continue; }
        const pcm = aligner.push(part.audio);
        if (!pcm.length) continue;
        const now = this.now();
        if (turn.stages.tts === undefined) {
          turn.stages.tts = Math.round(now - (turn.firstSentenceAt ?? now));
          this.send({ type: 'latency', source: 'model', ms: Math.round(now - turn.startedAt), stages: { ...turn.stages } });
        }
        // PCM 16 kHz mono 16 bits = 32 bytes por milissegundo.
        this.playbackUntil = Math.max(this.playbackUntil, now) + pcm.length / 32;
        this.send({ type: 'audio', audio: pcm.toString('base64'), sampleRate: 16000 });
      }
    } catch (error) { this.failTurn(turn, signal, error); }
  }
  fail(error) { if (this.closed) return; this.error = error; this.controller.abort(); }
  stop() {
    if (this.closed) return;
    this.audioQueue.close();
    this.stopTimer = setTimeout(() => this.abort(), 1500); this.stopTimer.unref?.();
  }
  abort() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); clearTimeout(this.stopTimer);
    this.audioQueue.close(); this.turn?.controller.abort(); this.controller.abort();
    this.adapters.destroy?.();
  }
}
