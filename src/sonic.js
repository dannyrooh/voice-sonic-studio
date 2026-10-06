import { randomUUID } from 'node:crypto';
import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { validateConfig, ValidationError } from './config.js';

const event = (type, data) => ({ event: { [type]: data } });
const languages = { 'pt-BR': 'português brasileiro', 'en-US': 'inglês', es: 'espanhol', fr: 'francês', de: 'alemão', it: 'italiano', hi: 'hindi' };
export class SonicProtocol {
  constructor(config) {
    this.config = validateConfig(config, { requireModel: true });
    this.promptName = randomUUID(); this.textName = randomUUID(); this.audioName = randomUUID();
  }
  start() {
    const c = this.config.conversation;
    return [
      event('sessionStart', {
        inferenceConfiguration: { maxTokens: c.maxTokens, temperature: c.temperature, topP: c.topP },
        turnDetectionConfiguration: { endpointingSensitivity: c.endpointingSensitivity },
      }),
      event('promptStart', {
        promptName: this.promptName,
        textOutputConfiguration: { mediaType: 'text/plain' },
        audioOutputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId: c.voiceId, encoding: 'base64', audioType: 'SPEECH' },
      }),
      event('contentStart', { promptName: this.promptName, contentName: this.textName, type: 'TEXT', interactive: false, role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' } }),
      event('textInput', { promptName: this.promptName, contentName: this.textName, content: `Seu nome é ${this.config.character.name}. Responda em ${languages[c.language]}.\n${c.systemPrompt}` }),
      event('contentEnd', { promptName: this.promptName, contentName: this.textName }),
      event('contentStart', { promptName: this.promptName, contentName: this.audioName, type: 'AUDIO', interactive: true, role: 'USER', audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' } }),
    ];
  }
  audio(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length % 2 || bytes.length > 8192) throw new ValidationError('Chunk PCM inválido.');
    return event('audioInput', { promptName: this.promptName, contentName: this.audioName, content: bytes.toString('base64') });
  }
  end() {
    return [event('contentEnd', { promptName: this.promptName, contentName: this.audioName }), event('promptEnd', { promptName: this.promptName }), event('sessionEnd', {})];
  }
}

export class EventQueue {
  constructor(limit = 256) { this.limit = limit; this.items = []; this.waiter = null; this.closed = false; }
  push(value) {
    if (this.closed) return;
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve({ value, done: false }); }
    else { if (this.items.length >= this.limit) throw new Error('A fila de áudio excedeu o limite. Reinicie a conversa.'); this.items.push(value); }
  }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise(resolve => { this.waiter = resolve; });
  }
  close() { this.closed = true; if (this.waiter) { this.waiter({ done: true }); this.waiter = null; } }
  [Symbol.asyncIterator]() { return this; }
}

export function outputMessage(e, blocks) {
  if (e.contentStart) {
    const c = e.contentStart;
    const extra = typeof c.additionalModelFields === 'string' ? JSON.parse(c.additionalModelFields) : c.additionalModelFields || {};
    blocks.set(c.contentId || c.contentName, { role: c.role, stage: extra.generationStage });
  }
  if (e.textOutput) {
    const t = e.textOutput;
    try { if (JSON.parse(t.content)?.interrupted === true) return { type: 'interrupted' }; } catch {}
    const id = t.contentId || t.contentName;
    const block = blocks.get(id);
    if (block && block.stage !== 'SPECULATIVE' && ['USER', 'ASSISTANT'].includes(block.role)) return { type: 'transcript', id, role: block.role, text: t.content };
  }
  if (e.audioOutput) return { type: 'audio', audio: e.audioOutput.content, sampleRate: 24000 };
  if (e.contentEnd) { blocks.delete(e.contentEnd.contentId || e.contentEnd.contentName); if (e.contentEnd.stopReason === 'INTERRUPTED') return { type: 'interrupted' }; }
  if (e.usageEvent) return { type: 'usage', inputTokens: e.usageEvent.totalInputTokens, outputTokens: e.usageEvent.totalOutputTokens };
  return null;
}

// Fim do bloco USER (turno detectado pelo modelo) até o primeiro áudio da resposta; deve observar antes de outputMessage.
export class LatencyMeter {
  constructor() { this.userEndedAt = null; }
  observe(e, blocks, now) {
    if (e.contentEnd && blocks.get(e.contentEnd.contentId || e.contentEnd.contentName)?.role === 'USER') this.userEndedAt = now;
    if (e.audioOutput && this.userEndedAt !== null) { const ms = Math.round(now - this.userEndedAt); this.userEndedAt = null; return ms; }
    return null;
  }
}

export class SonicSession {
  constructor(config, send, awsSettings) {
    this.protocol = new SonicProtocol(config); this.send = send;
    this.awsSettings = awsSettings;
    this.queue = new EventQueue(); this.controller = new AbortController(); this.blocks = new Map(); this.latency = new LatencyMeter();
    this.closed = false;
  }
  async start() {
    const connection = this.protocol.config.connection;
    this.client = new BedrockRuntimeClient({
      region: this.awsSettings.region, credentials: fromIni({ profile: this.awsSettings.awsProfile }),
      requestHandler: new NodeHttp2Handler({ requestTimeout: 300000, sessionTimeout: 300000 }),
      maxAttempts: 1,
    });
    for (const e of this.protocol.start()) this.queue.push(e);
    const queue = this.queue;
    async function* body() { for await (const e of queue) yield { chunk: { bytes: Buffer.from(JSON.stringify(e)) } }; }
    const response = await this.client.send(new InvokeModelWithBidirectionalStreamCommand({ modelId: connection.modelId, body: body() }), { abortSignal: this.controller.signal });
    if (this.closed) return;
    this.send({ type: 'ready' });
    if (!response.body) throw new Error('Sonic não retornou um stream de resposta.');
    for await (const chunk of response.body) {
      if (this.closed) break;
      if (chunk.chunk?.bytes) {
        const parsed = JSON.parse(Buffer.from(chunk.chunk.bytes).toString('utf8'));
        const latency = this.latency.observe(parsed.event || {}, this.blocks, performance.now());
        if (latency !== null) this.send({ type: 'latency', source: 'model', ms: latency });
        const message = outputMessage(parsed.event || {}, this.blocks);
        if (message) this.send(message);
      } else {
        const exception = Object.entries(chunk).find(([key]) => key.endsWith('Exception'));
        if (exception) throw new Error(`${exception[0]}: ${exception[1].message || 'Falha no stream Sonic.'}`);
      }
    }
  }
  audio(bytes) { if (!this.closed) this.queue.push(this.protocol.audio(bytes)); }
  stop() {
    if (this.closed) return;
    try { for (const e of this.protocol.end()) this.queue.push(e); } finally {
      this.queue.close();
      this.stopTimer = setTimeout(() => this.abort(), 1500); this.stopTimer.unref();
    }
  }
  abort() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.stopTimer); this.queue.close();
    this.controller.abort(); this.client?.destroy(); this.blocks.clear();
  }
}
