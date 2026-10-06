import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/config.js';
import { SonicProtocol, EventQueue, outputMessage, LatencyMeter } from '../src/sonic.js';

test('builds ordered Sonic events with configured voice, inference, turns and audio format', () => {
  const c = defaults();
  c.connection.modelId = 'amazon.nova-2-sonic-v1:0';
  c.conversation.endpointingSensitivity = 'HIGH';
  const p = new SonicProtocol(c);
  const events = p.start();
  assert.equal(events[0].event.sessionStart.turnDetectionConfiguration.endpointingSensitivity, 'HIGH');
  assert.equal(events[0].event.sessionStart.inferenceConfiguration.temperature, 0.7);
  assert.equal(events[1].event.promptStart.audioOutputConfiguration.voiceId, 'carolina');
  assert.equal(events[1].event.promptStart.audioOutputConfiguration.sampleRateHertz, 24000);
  assert.equal(events[2].event.contentStart.role, 'SYSTEM');
  assert.match(events[3].event.textInput.content, /português brasileiro/);
  assert.equal(events[5].event.contentStart.audioInputConfiguration.sampleRateHertz, 16000);
  assert.equal(p.audio(Buffer.from([0, 1])).event.audioInput.content, 'AAE=');
  assert.deepEqual(p.end().map(e => Object.keys(e.event)[0]), ['contentEnd', 'promptEnd', 'sessionEnd']);
});

test('rejects missing model before streaming and invalid PCM chunks', () => {
  assert.throws(() => new SonicProtocol({ ...defaults(), connection: { ...defaults().connection, modelId: '' } }), /modelo/i);
  const c = defaults(); c.connection.modelId = 'amazon.nova-2-sonic-v1:0';
  const p = new SonicProtocol(c);
  assert.throws(() => p.audio(Buffer.from([1])), /PCM/i);
  assert.throws(() => p.audio(Buffer.alloc(20000)), /PCM/i);
});

test('routes final transcripts, audio and interruptions without exposing speculative text', () => {
  const blocks = new Map();
  outputMessage({ contentStart: { contentId: 'a', role: 'ASSISTANT', additionalModelFields: '{"generationStage":"SPECULATIVE"}' } }, blocks);
  assert.equal(outputMessage({ textOutput: { contentId: 'a', content: 'planejado' } }, blocks), null);
  outputMessage({ contentStart: { contentId: 'b', role: 'USER', additionalModelFields: '{"generationStage":"FINAL"}' } }, blocks);
  assert.deepEqual(outputMessage({ textOutput: { contentId: 'b', content: 'Olá' } }, blocks), { type: 'transcript', id: 'b', role: 'USER', text: 'Olá' });
  assert.deepEqual(outputMessage({ textOutput: { content: '{ "interrupted": true }' } }, blocks), { type: 'interrupted' });
  assert.deepEqual(outputMessage({ contentEnd: { contentId: 'a', stopReason: 'INTERRUPTED' } }, blocks), { type: 'interrupted' });
  assert.deepEqual(outputMessage({ audioOutput: { content: 'AAE=' } }, blocks), { type: 'audio', audio: 'AAE=', sampleRate: 24000 });
});

test('measures model latency from end of user turn to first assistant audio', () => {
  const blocks = new Map(); const meter = new LatencyMeter();
  const observe = (e, now) => { const ms = meter.observe(e, blocks, now); outputMessage(e, blocks); return ms; };
  assert.equal(observe({ audioOutput: { content: 'AAE=' } }, 0), null, 'áudio sem turno do usuário não mede');
  observe({ contentStart: { contentId: 'u', role: 'USER' } }, 100);
  observe({ textOutput: { contentId: 'u', content: 'Oi' } }, 150);
  assert.equal(observe({ contentEnd: { contentId: 'u' } }, 1000), null);
  observe({ contentStart: { contentId: 'a', role: 'ASSISTANT' } }, 1100);
  assert.equal(observe({ contentEnd: { contentId: 'a' } }, 1200), null, 'fim de bloco do assistente não reinicia');
  assert.equal(observe({ audioOutput: { content: 'AAE=' } }, 1650.4), 650);
  assert.equal(observe({ audioOutput: { content: 'AAE=' } }, 1700), null, 'mede só o primeiro áudio');
});

test('queue wakes consumer, bounds backlog and ends pending reads on close', async () => {
  const q = new EventQueue(2);
  const pending = q.next(); q.push('first');
  assert.deepEqual(await pending, { value: 'first', done: false });
  q.push('second'); q.push('third');
  assert.throws(() => q.push('fourth'), /fila/i);
  assert.equal((await q.next()).value, 'second');
  q.close();
  assert.equal((await q.next()).value, 'third');
  assert.equal((await q.next()).done, true);
  const empty = new EventQueue(); const waiting = empty.next(); empty.close();
  assert.equal((await waiting).done, true);
});
