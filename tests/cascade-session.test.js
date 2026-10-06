import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../src/config.js';
import { EventQueue } from '../src/sonic.js';
import { CascadeSession } from '../src/cascade/session.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let i = 0; i < 10; i++) await tick(); }
const loud = () => Buffer.from(new Int16Array(512).fill(8000).buffer);
function config(conversation = {}) {
  const c = validateConfig({ ...defaults(), pipeline: 'polly', cascade: { llmModelId: 'us.amazon.nova-micro-v1:0', pollyVoiceId: 'Camila' } }, { requireModel: true });
  Object.assign(c.conversation, conversation);
  return c;
}
function fakeAdapters({ replies = [['Olá! ', 'Tudo bem?']], replyError = null } = {}) {
  const results = new EventQueue();
  const a = {
    results, calls: { reply: [], speak: [] }, destroyed: false,
    async *transcribe(audio, language, signal) {
      a.calls.language = language;
      (async () => { for await (const chunk of audio) void chunk; results.close(); })();
      signal.addEventListener('abort', () => results.close());
      for await (const result of results) yield result;
      if (signal.aborted) throw signal.reason;
    },
    async *reply(request, signal) {
      a.calls.reply.push(structuredClone({ system: request.system, messages: request.messages }));
      if (replyError) throw replyError;
      for (const item of replies.shift() ?? []) {
        if (typeof item === 'function') await item(); else await tick();
        if (signal.aborted) throw signal.reason;
        if (typeof item === 'string') yield { text: item };
      }
      yield { usage: { inputTokens: 10, outputTokens: 5 } };
    },
    async *speak(texts, voiceId, signal) {
      const call = { voiceId, texts: [] }; a.calls.speak.push(call);
      for await (const text of texts) { call.texts.push(text); if (signal.aborted) throw signal.reason; yield { audio: Buffer.alloc(3200) }; }
      yield { characters: call.texts.join('').length };
    },
    destroy() { a.destroyed = true; },
  };
  return a;
}

test('responds after silence with streamed text, Polly audio, latency and usage', async () => {
  let clock = 0; const sent = []; const a = fakeAdapters();
  const s = new CascadeSession(config(), m => sent.push(m), a, { now: () => clock, pollMs: 1e6 });
  const running = s.start();
  s.audio(loud()); a.results.push({ id: 'r1', text: 'Quero saber', partial: true }); await flush();
  clock = 100; s.audio(loud()); a.results.push({ id: 'r1', text: 'Quero saber o prazo', partial: true }); await flush();
  clock = 700; s.poll(); assert.equal(s.turn, null, 'silêncio de 600 ms ainda é menor que 700 ms');
  clock = 900; s.poll(); assert.ok(s.turn); await s.pending;
  assert.equal(sent[0].type, 'ready');
  assert.equal(a.calls.language, 'pt-BR');
  assert.deepEqual(a.calls.reply[0].messages, [{ role: 'user', content: [{ text: 'Quero saber o prazo' }] }]);
  assert.match(a.calls.reply[0].system, /Seu nome é Aurora[\s\S]*sem markdown/);
  assert.deepEqual(a.calls.speak[0], { voiceId: 'Camila', texts: ['Olá! Tudo bem?'] });
  assert.deepEqual(sent.filter(m => m.type === 'transcript').map(m => [m.role, m.text]), [['USER', 'Quero saber o prazo'], ['ASSISTANT', 'Olá! '], ['ASSISTANT', 'Tudo bem?']]);
  const audio = sent.filter(m => m.type === 'audio');
  assert.equal(audio.length, 1); assert.equal(audio[0].sampleRate, 16000); assert.equal(Buffer.from(audio[0].audio, 'base64').length, 3200);
  assert.deepEqual(sent.find(m => m.type === 'latency'), { type: 'latency', source: 'model', ms: 0, stages: { llm: 0, tts: 0 } });
  assert.deepEqual(sent.findLast(m => m.type === 'usage'), { type: 'usage', inputTokens: 10, outputTokens: 5, ttsCharacters: 14 });
  assert.deepEqual(s.history.at(-1), { role: 'assistant', content: [{ text: 'Olá! Tudo bem?' }] });
  s.stop(); await running; s.abort();
  assert.equal(a.destroyed, true);
});

test('late final of answered speech keeps talking; new speech interrupts and keeps the partial reply', async () => {
  let clock = 0; const sent = []; let release; const gate = new Promise(resolve => { release = resolve; });
  const a = fakeAdapters({ replies: [['Primeira parte da resposta. ', () => gate, 'nunca dita.'], ['Pode falar.']] });
  const s = new CascadeSession(config(), m => sent.push(m), a, { now: () => clock, pollMs: 1e6 });
  const running = s.start();
  s.audio(loud()); a.results.push({ id: 'r1', text: 'Oi', partial: true }); await flush();
  clock = 1000; s.poll(); await flush();
  assert.equal(sent.filter(m => m.type === 'audio').length, 1, 'a primeira frase já virou voz');
  a.results.push({ id: 'r1', text: 'Oi.', partial: false }); await flush();
  assert.equal(sent.some(m => m.type === 'interrupted'), false);
  clock = 1100; s.audio(loud()); a.results.push({ id: 'r2', text: 'Espera', partial: true }); await flush();
  assert.equal(sent.filter(m => m.type === 'interrupted').length, 1);
  release(); await s.pending;
  assert.equal(sent.some(m => m.text === 'nunca dita.'), false);
  assert.deepEqual(s.history, [{ role: 'user', content: [{ text: 'Oi' }] }, { role: 'assistant', content: [{ text: 'Primeira parte da resposta.' }] }]);
  clock = 2000; s.poll(); await s.pending;
  assert.deepEqual(a.calls.reply[1].messages.at(-1), { role: 'user', content: [{ text: 'Espera' }] });
  s.stop(); await running; s.abort();
});

test('without interruption speech waits; back-to-back user turns merge; stop mid-turn aborts cleanly', async () => {
  let clock = 0; let release; const gate = new Promise(resolve => { release = resolve; }); const sent = [];
  const a = fakeAdapters({ replies: [[], [() => gate, 'tarde demais']] });
  const s = new CascadeSession(config({ allowInterruption: false }), m => sent.push(m), a, { now: () => clock, pollMs: 1e6 });
  const running = s.start();
  s.audio(loud()); a.results.push({ id: 'r1', text: 'Oi', partial: false }); await flush();
  clock = 1000; s.poll(); await s.pending;
  s.audio(loud()); a.results.push({ id: 'r2', text: 'Tudo bem?', partial: false }); await flush();
  clock = 2000; s.poll(); await flush();
  assert.deepEqual(a.calls.reply[1].messages, [{ role: 'user', content: [{ text: 'Oi Tudo bem?' }] }]);
  s.audio(loud()); a.results.push({ id: 'r3', text: 'Alô', partial: true }); await flush();
  assert.equal(sent.some(m => m.type === 'interrupted'), false);
  s.stop(); await running; s.abort(); release(); await s.pending;
  assert.equal(s.error, null);
  assert.equal(a.destroyed, true);
});

test('Bedrock failure ends the session with the original error', async () => {
  let clock = 0; const a = fakeAdapters({ replyError: new Error('AccessDeniedException: sem acesso ao modelo') });
  const s = new CascadeSession(config(), () => {}, a, { now: () => clock, pollMs: 1e6 });
  const running = s.start();
  s.audio(loud()); a.results.push({ id: 'r1', text: 'Oi', partial: false }); await flush();
  clock = 1000; s.poll();
  await assert.rejects(running, /AccessDenied/);
  s.abort();
});

test('speech resumed inside an answered result id interrupts and is answered alone', async () => {
  let clock = 0; const sent = []; let release; const gate = new Promise(resolve => { release = resolve; });
  const a = fakeAdapters({ replies: [['Primeira parte da resposta. ', () => gate, 'nunca dita.'], ['Certo.']] });
  const s = new CascadeSession(config(), m => sent.push(m), a, { now: () => clock, pollMs: 1e6 });
  const running = s.start();
  s.audio(loud()); a.results.push({ id: 'r1', text: 'Quero saber o prazo', partial: true }); await flush();
  clock = 1000; s.poll(); await flush();
  assert.ok(s.turn);
  clock = 1100; s.audio(loud()); a.results.push({ id: 'r1', text: 'Quero saber o prazo de entrega', partial: true }); await flush();
  assert.equal(sent.filter(m => m.type === 'interrupted').length, 1);
  release(); await s.pending;
  clock = 2500; s.poll(); await s.pending;
  assert.deepEqual(a.calls.reply[1].messages.at(-1), { role: 'user', content: [{ text: 'de entrega' }] });
  s.stop(); await running; s.abort();
});

test('a stalled turn times out and ends the session with a visible error', async () => {
  let clock = 0; const a = fakeAdapters();
  a.reply = async function* (request, signal) { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))); };
  const s = new CascadeSession(config(), () => {}, a, { now: () => clock, pollMs: 1e6, turnTimeoutMs: 20 });
  const running = s.start();
  s.audio(loud()); a.results.push({ id: 'r1', text: 'Oi', partial: false }); await flush();
  clock = 1000; s.poll();
  await assert.rejects(running, /demorou mais de/);
  s.abort();
});

test('audio rejects invalid PCM chunks', () => {
  const s = new CascadeSession(config(), () => {}, fakeAdapters(), { pollMs: 1e6 });
  assert.throws(() => s.audio(Buffer.alloc(3)), /PCM/);
  assert.throws(() => s.audio(Buffer.alloc(0)), /PCM/);
  assert.throws(() => s.audio('x'), /PCM/);
  assert.throws(() => s.audio(Buffer.alloc(8194)), /PCM/);
});

test('ElevenLabs pipeline speaks with the ElevenLabs voice', async () => {
  let clock = 0; const a = fakeAdapters();
  const c = validateConfig({ ...defaults(), pipeline: 'elevenlabs', cascade: { llmModelId: 'us.amazon.nova-micro-v1:0', pollyVoiceId: 'Camila', elevenVoiceId: 'voz123' } }, { requireModel: true });
  const s = new CascadeSession(c, () => {}, a, { now: () => clock, pollMs: 1e6 });
  const running = s.start();
  s.audio(loud()); a.results.push({ id: 'r1', text: 'Oi', partial: false }); await flush();
  clock = 1000; s.poll(); await s.pending;
  assert.equal(a.calls.speak[0].voiceId, 'voz123');
  s.stop(); await running; s.abort();
});
