import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createElevenLabsSpeaker, listElevenLabsVoices, elevenLabsSettings } from '../src/cascade/elevenlabs.js';

async function* from(items) { for (const item of items) yield item; }
async function collect(iterable) { const items = []; for await (const item of iterable) items.push(item); return items; }
// Simula o servidor do ElevenLabs: responde ao texto vazio final com um áudio e isFinal.
function fakeSocket(reply = socket => {
  socket.emit('message', Buffer.from(JSON.stringify({ audio: Buffer.from([1, 2, 3, 4]).toString('base64') })));
  socket.emit('message', Buffer.from(JSON.stringify({ isFinal: true })));
}) {
  return class FakeSocket extends EventEmitter {
    static OPEN = 1; static last = null;
    constructor(url, options) {
      super(); this.url = new URL(url); this.options = options; this.sent = []; this.readyState = 0; this.terminated = false;
      FakeSocket.last = this;
      setImmediate(() => { this.readyState = 1; this.emit('open'); });
    }
    send(data) { const message = JSON.parse(data); this.sent.push(message); if (message.text === '') setImmediate(() => reply(this)); }
    terminate() { if (this.terminated) return; this.terminated = true; this.readyState = 3; this.emit('close', 1006, Buffer.from('')); }
  };
}

test('settings come from the environment without defaults in code', () => {
  assert.deepEqual(elevenLabsSettings({ ELEVENLABS_API_KEY: ' k ', ELEVENLABS_MODEL_ID: ' eleven_flash_v2_5 ' }), { apiKey: 'k', modelId: 'eleven_flash_v2_5' });
  assert.deepEqual(elevenLabsSettings({}), { apiKey: '', modelId: '' });
});

test('speaker streams sentences with flush and yields PCM and characters', async () => {
  const FakeSocket = fakeSocket();
  const speak = createElevenLabsSpeaker({ apiKey: 'chave', modelId: 'eleven_flash_v2_5', language: 'pt-BR' }, { WebSocketImpl: FakeSocket });
  const parts = await collect(speak(from(['Olá.', 'Tudo bem? ']), 'voz123'));
  assert.deepEqual(parts, [{ audio: Buffer.from([1, 2, 3, 4]) }, { characters: 14 }]);
  const socket = FakeSocket.last;
  assert.equal(socket.url.pathname, '/v1/text-to-speech/voz123/stream-input');
  assert.deepEqual(Object.fromEntries(socket.url.searchParams), { model_id: 'eleven_flash_v2_5', output_format: 'pcm_16000', language_code: 'pt', inactivity_timeout: '60' });
  assert.equal(socket.options.headers['xi-api-key'], 'chave');
  assert.deepEqual(socket.sent, [{ text: ' ' }, { text: 'Olá. ', flush: true }, { text: 'Tudo bem? ', flush: true }, { text: '' }]);
  assert.equal(socket.terminated, true, 'conexão encerrada ao terminar');
});

test('speaker surfaces service errors and abnormal closes', async () => {
  const quota = fakeSocket(socket => socket.emit('message', Buffer.from(JSON.stringify({ error: 'quota_exceeded', message: 'This request exceeds your quota.' }))));
  await assert.rejects(collect(createElevenLabsSpeaker({ apiKey: 'k', modelId: 'm', language: 'pt-BR' }, { WebSocketImpl: quota })(from(['Oi.']), 'v')), /ElevenLabs: This request exceeds your quota\./);
  const closed = fakeSocket(socket => { socket.readyState = 3; socket.emit('close', 1008, Buffer.from('invalid_output_format')); });
  await assert.rejects(collect(createElevenLabsSpeaker({ apiKey: 'k', modelId: 'm', language: 'pt-BR' }, { WebSocketImpl: closed })(from(['Oi.']), 'v')), /1008: invalid_output_format/);
});

test('abort closes the connection and stops without an error', async () => {
  const FakeSocket = fakeSocket(() => {});
  const controller = new AbortController();
  async function* texts() { yield 'Primeira frase.'; await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(); yield 'nunca enviada.'; }
  const parts = await collect(createElevenLabsSpeaker({ apiKey: 'k', modelId: 'm', language: 'pt-BR' }, { WebSocketImpl: FakeSocket })(texts(), 'v', controller.signal));
  assert.equal(parts.some(part => part.audio), false);
  assert.equal(FakeSocket.last.terminated, true);
  assert.equal(FakeSocket.last.sent.some(message => message.text === 'nunca enviada. '), false);
});

test('voice list uses the API key header and maps ids and labels', async () => {
  let request;
  const fetchImpl = async (url, options) => { request = { url: String(url), options }; return { ok: true, json: async () => ({ voices: [{ voice_id: 'abc', name: 'Bia', labels: { accent: 'brazilian', gender: 'female' } }] }) }; };
  assert.deepEqual(await listElevenLabsVoices({ apiKey: 'chave' }, fetchImpl), [{ id: 'abc', name: 'Bia', label: 'Bia · brazilian · female' }]);
  assert.equal(request.url, 'https://api.elevenlabs.io/v2/voices?page_size=100');
  assert.equal(request.options.headers['xi-api-key'], 'chave');
  const denied = async () => ({ ok: false, status: 401, text: async () => '{"detail":"invalid_api_key"}' });
  await assert.rejects(listElevenLabsVoices({ apiKey: 'x' }, denied), /HTTP 401/);
});
