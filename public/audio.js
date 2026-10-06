import { decodePcm } from './pcm.js';
import { voiceLevel, VOICE_THRESHOLD } from './metrics.js';
export class AudioBridge {
  constructor(onChunk, onState, onLatency = () => {}) {
    this.onChunk = onChunk; this.onState = onState; this.onLatency = onLatency;
    this.nodes = new Set(); this.closed = false; this.capturing = false; this.nextTime = 0;
    this.lastVoiceAt = null; this.measuredVoiceAt = null;
  }
  async prepare() {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext) throw new Error('Use um navegador atual em localhost para acessar o microfone.');
    this.context = new AudioContext();
    await this.context.resume();
    if (this.closed) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.closed) { this.stream.getTracks().forEach(track => track.stop()); return; }
    await this.context.audioWorklet.addModule('/capture-worklet.js');
    if (this.closed) return;
    this.input = this.context.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.context, 'pcm-capture');
    this.silent = this.context.createGain(); this.silent.gain.value = 0;
    this.capture.port.onmessage = event => this.handleCapture(event.data);
    this.input.connect(this.capture); this.capture.connect(this.silent); this.silent.connect(this.context.destination);
  }
  handleCapture(data) {
    if (!this.capturing || this.closed) return;
    if (!this.allowInterruption && this.isPlaying()) { this.onChunk(new ArrayBuffer(data.byteLength)); return; }
    // Fim de fala aproximado pelo último chunk com voz (resolução de 32 ms).
    if (voiceLevel(data) >= VOICE_THRESHOLD) this.lastVoiceAt = performance.now();
    this.onChunk(data);
  }
  begin(allowInterruption) { this.allowInterruption = allowInterruption; this.capturing = true; this.onState('Ouvindo'); }
  isPlaying() { return this.nodes.size > 0; }
  play(base64, rate) {
    if (this.closed) return;
    const raw = atob(base64); const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const samples = decodePcm(bytes.buffer);
    if (!samples.length) return;
    if (this.nextTime - this.context.currentTime > 30) throw new Error('A reprodução ficou muito atrasada. Reinicie a conversa.');
    const buffer = this.context.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const node = this.context.createBufferSource(); node.buffer = buffer; node.connect(this.context.destination);
    const responseStart = !this.nodes.size;
    this.nodes.add(node); this.onState('Falando');
    node.onended = () => { this.nodes.delete(node); node.disconnect(); if (!this.nodes.size && !this.closed) this.onState('Ouvindo'); };
    const at = Math.max(this.context.currentTime + 0.02, this.nextTime);
    node.start(at); this.nextTime = at + buffer.duration;
    if (responseStart && this.lastVoiceAt !== null && this.lastVoiceAt !== this.measuredVoiceAt) {
      this.measuredVoiceAt = this.lastVoiceAt;
      this.onLatency(Math.round(performance.now() + (at - this.context.currentTime) * 1000 - this.lastVoiceAt));
    }
  }
  interrupt() {
    for (const node of this.nodes) { node.onended = null; try { node.stop(); } catch {} node.disconnect(); }
    this.nodes.clear(); this.nextTime = 0;
    if (!this.closed) this.onState('Ouvindo');
  }
  close() {
    this.closed = true; this.capturing = false; this.interrupt();
    this.capture?.disconnect(); this.input?.disconnect(); this.silent?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
  }
}
