# Transcribe + Bedrock + ElevenLabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar a arquitetura "Transcribe + Bedrock + ElevenLabs", reaproveitando a cascata do Polly e trocando só o sintetizador de voz.

**Architecture:** Novo valor `pipeline: 'elevenlabs'`. `src/cascade/elevenlabs.js` traz um adaptador `speak` sobre o WebSocket `stream-input` do ElevenLabs (pacote `ws`, já instalado), a listagem de vozes e a leitura das variáveis do `.env`. `createSession` usa os adaptadores AWS da cascata e substitui só `speak`. A tela ganha a opção, o campo de voz e um botão que lista as vozes da conta pelo servidor.

**Tech Stack:** Node.js 22+, Express 5, ws 8, AWS SDK v3 (já instalado), `node:test`, jsdom.

**Spec:** `docs/elevenlabs-cascade-design.md`

## Global Constraints

- Branch: `feat/elevenlabs-cascade`. Todo commit termina com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nenhuma dependência nova.
- ElevenLabs: URL `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`, parâmetros `model_id`, `output_format=pcm_16000`, `language_code`, `inactivity_timeout=60`; cabeçalho `xi-api-key`. Mensagens: `{"text":" "}` inicial, `{"text":"<frase> ","flush":true}` por frase, `{"text":""}` no fim.
- Listagem de vozes: `GET https://api.elevenlabs.io/v2/voices?page_size=100`, cabeçalho `xi-api-key`, timeout 15 s.
- `language_code`: `pt-BR`→`pt`, `en-US`→`en`, `es`, `fr`, `de`, `it`, `hi`.
- Variáveis do `.env`: `ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL_ID` (exemplo `eleven_flash_v2_5`), `ELEVENLABS_VOICE_ID` (padrão da voz). A chave nunca vai ao navegador, ao JSON nem a logs.
- `schemaVersion` continua `1`; JSON sem `cascade.elevenVoiceId` continua válido.
- Testes não chamam a rede. `npm test` e `npm run check` passam ao fim de cada tarefa, com saída limpa.
- Interface em português; mensagens de erro dizem o que fazer.

## Review Focus

- Chave ausente no `.env` com a arquitetura ElevenLabs escolhida: a conversa não inicia e a mensagem diz para definir a chave e reiniciar. Teste: Task 3.
- ElevenLabs recusa (cota esgotada, voz inválida, formato não liberado no plano): o erro chega à tela com o texto do serviço. Teste: Task 2.
- Interrupção no meio da fala: a conexão do ElevenLabs é encerrada e nada mais é enviado. Teste: Task 2.
- JSON salvo na versão do Polly (sem `elevenVoiceId`) abre sem erro. Teste: Task 1.
- Campo de voz do ElevenLabs escondido e vazio não trava salvar nem exportar nas outras arquiteturas. Teste: Task 4.

---

### Task 1: Configuração com `elevenlabs` e `cascade.elevenVoiceId`

**Files:**
- Modify: `src/config.js`
- Modify: `.env.example`
- Test: `tests/config.test.js`, `tests/ui.test.js` (uma linha)

**Interfaces:**
- Produces: `PIPELINES = ['sonic', 'polly', 'elevenlabs']`; `defaults().cascade.elevenVoiceId` = `process.env.ELEVENLABS_VOICE_ID || ''`; `validateConfig` exige `cascade.llmModelId` para `polly` e `elevenlabs`, e `cascade.elevenVoiceId` para `elevenlabs` (com `requireModel`); `conversation.voiceId` só é obrigatório para `sonic`; retorno de `cascade` sempre com `llmModelId`, `pollyVoiceId`, `elevenVoiceId`.

- [ ] **Step 1: Write the failing test**

Em `tests/config.test.js`, trocar a linha

```js
  assert.deepEqual(ready.cascade, { llmModelId: 'us.amazon.nova-2-lite-v1:0', pollyVoiceId: 'Camila' });
```

por

```js
  assert.deepEqual(ready.cascade, { llmModelId: 'us.amazon.nova-2-lite-v1:0', pollyVoiceId: 'Camila', elevenVoiceId: '' });
```

e adicionar ao fim do arquivo:

```js
test('ElevenLabs pipeline needs text model and voice; Polly-era files stay valid', () => {
  const pollyEra = { ...defaults(), pipeline: 'polly', cascade: { llmModelId: 'us.amazon.nova-2-lite-v1:0', pollyVoiceId: 'Camila' } };
  assert.equal(validateConfig(pollyEra, { requireModel: true }).cascade.elevenVoiceId, '');
  const eleven = { ...defaults(), pipeline: 'elevenlabs', conversation: { ...defaults().conversation, voiceId: '' }, cascade: { llmModelId: 'us.amazon.nova-micro-v1:0', pollyVoiceId: 'Camila', elevenVoiceId: '' } };
  assert.throws(() => validateConfig(eleven, { requireModel: true }), /voz do elevenlabs/i);
  assert.throws(() => validateConfig({ ...eleven, cascade: { ...eleven.cascade, llmModelId: '' } }, { requireModel: true }), /modelo de texto/i);
  const ready = validateConfig({ ...eleven, cascade: { ...eleven.cascade, elevenVoiceId: ' 21m00Tcm4TlvDq8ikWAM ' } }, { requireModel: true });
  assert.equal(ready.pipeline, 'elevenlabs');
  assert.equal(ready.cascade.elevenVoiceId, '21m00Tcm4TlvDq8ikWAM');
  assert.equal(ready.conversation.voiceId, '');
  assert.throws(() => validateConfig({ ...eleven, cascade: { ...eleven.cascade, apiKey: 'segredo' } }), /campo/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL (`elevenVoiceId` ausente no `deepEqual` e `Arquitetura inválida.` para `elevenlabs`).

- [ ] **Step 3: Write minimal implementation**

Em `src/config.js`, trocar a linha de `PIPELINES` por:

```js
export const PIPELINES = ['sonic', 'polly', 'elevenlabs'];
const CASCADE_PIPELINES = ['polly', 'elevenlabs'];
```

Em `defaults()`, trocar a linha de `cascade` por:

```js
    cascade: { llmModelId: process.env.CASCADE_LLM_MODEL_ID || '', pollyVoiceId: 'Camila', elevenVoiceId: process.env.ELEVENLABS_VOICE_ID || '' },
```

Em `validateConfig`, trocar as duas linhas

```js
  // Arquivos anteriores à arquitetura em cascata não têm o grupo cascade.
  const cascade = input.cascade ?? defaults().cascade;
  object(cascade, ['llmModelId', 'pollyVoiceId'], 'cascata');
```

por

```js
  if (input.cascade !== undefined) object(input.cascade, ['llmModelId', 'pollyVoiceId', 'elevenVoiceId'], 'cascata');
  // Arquivos anteriores não têm o grupo cascade ou a voz do ElevenLabs.
  const cascade = { ...defaults().cascade, ...input.cascade };
```

No objeto retornado, trocar o bloco `cascade: { … }` por:

```js
    cascade: {
      llmModelId: string(cascade.llmModelId, 'Modelo de texto', 200, !(requireModel && CASCADE_PIPELINES.includes(pipeline))),
      pollyVoiceId: string(cascade.pollyVoiceId, 'Voz do Polly', 40),
      elevenVoiceId: string(cascade.elevenVoiceId, 'Voz do ElevenLabs', 64, !(requireModel && pipeline === 'elevenlabs')),
    },
```

E em `conversation`, trocar `pipeline === 'polly'` da linha de `voiceId` por `pipeline !== 'sonic'`:

```js
      voiceId: string(c.voiceId, 'Identificador da voz', 80, pipeline !== 'sonic'), language: c.language,
```

Em `.env.example`, adicionar ao fim:

```dotenv
# ElevenLabs (arquitetura Transcribe + Bedrock + ElevenLabs). A chave fica só no servidor.
ELEVENLABS_API_KEY=
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
# ID de uma voz da sua conta (use "Consultar vozes do ElevenLabs" na tela).
ELEVENLABS_VOICE_ID=
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/config.test.js`, depois `npm test` e `npm run check`.
Expected: PASS. O JSON exportado passa a trazer `elevenVoiceId`, então em `tests/ui.test.js` troque a linha `assert.deepEqual(cascade.cascade, { llmModelId: 'us.amazon.nova-micro-v1:0', pollyVoiceId: 'Camila' });` por `assert.deepEqual(cascade.cascade, { llmModelId: 'us.amazon.nova-micro-v1:0', pollyVoiceId: 'Camila', elevenVoiceId: '' });` (faça a troca antes do Step 2 para o RED mostrar só as falhas novas).

- [ ] **Step 5: Commit**

```bash
git add src/config.js .env.example tests/config.test.js tests/ui.test.js
git commit -m "feat: arquitetura elevenlabs e voz do ElevenLabs na configuração

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Adaptador do ElevenLabs (voz em streaming e lista de vozes)

**Files:**
- Create: `src/cascade/elevenlabs.js`
- Test: `tests/cascade-elevenlabs.test.js`

**Interfaces:**
- Consumes: `EventQueue` de `src/sonic.js`.
- Produces:
  - `ELEVEN_LANGUAGES: Record<language, string>`
  - `elevenLabsSettings(env = process.env): { apiKey: string, modelId: string }`
  - `createElevenLabsSpeaker({ apiKey, modelId, language }, { WebSocketImpl = WebSocket } = {})` → função geradora `speakWithElevenLabs(texts: AsyncIterable<string>, voiceId: string, signal?: AbortSignal)` com a mesma forma do `speak` da AWS: produz `{ audio: Buffer }` e, no fim, `{ characters: number }`.
  - `listElevenLabsVoices({ apiKey }, fetchImpl = fetch): Promise<{ id, name, label }[]>`

- [ ] **Step 1: Write the failing test**

Criar `tests/cascade-elevenlabs.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cascade-elevenlabs.test.js`
Expected: FAIL com `Cannot find module '.../src/cascade/elevenlabs.js'`.

- [ ] **Step 3: Write minimal implementation**

Criar `src/cascade/elevenlabs.js`:

```js
import WebSocket from 'ws';
import { EventQueue } from '../sonic.js';

export const ELEVEN_LANGUAGES = { 'pt-BR': 'pt', 'en-US': 'en', es: 'es', fr: 'fr', de: 'de', it: 'it', hi: 'hi' };

export function elevenLabsSettings(env = process.env) {
  return { apiKey: env.ELEVENLABS_API_KEY?.trim() || '', modelId: env.ELEVENLABS_MODEL_ID?.trim() || '' };
}

// Mesmo contrato do speak da AWS: frases entram, PCM 16 kHz sai, e no fim a contagem de caracteres.
export function createElevenLabsSpeaker({ apiKey, modelId, language }, { WebSocketImpl = WebSocket } = {}) {
  return async function* speakWithElevenLabs(texts, voiceId, signal) {
    const query = new URLSearchParams({ model_id: modelId, output_format: 'pcm_16000', language_code: ELEVEN_LANGUAGES[language], inactivity_timeout: '60' });
    const socket = new WebSocketImpl(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${query}`, { headers: { 'xi-api-key': apiKey } });
    const events = new EventQueue(4096);
    socket.on('message', data => events.push({ data }));
    socket.on('error', error => events.push({ error }));
    socket.on('close', (code, reason) => { events.push({ close: { code, reason: String(reason || '') } }); events.close(); });
    const abort = () => socket.terminate();
    signal?.addEventListener('abort', abort, { once: true });
    let characters = 0;
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', resolve); });
      if (signal?.aborted || socket.readyState !== WebSocketImpl.OPEN) return;
      socket.send(JSON.stringify({ text: ' ' }));
      // Envia frase a frase enquanto o áudio chega; o texto vazio fecha a geração.
      const sender = (async () => {
        for await (const text of texts) {
          if (signal?.aborted || socket.readyState !== WebSocketImpl.OPEN) return;
          characters += text.length;
          socket.send(JSON.stringify({ text: text.endsWith(' ') ? text : `${text} `, flush: true }));
        }
        if (!signal?.aborted && socket.readyState === WebSocketImpl.OPEN) socket.send(JSON.stringify({ text: '' }));
      })();
      sender.catch(() => {});
      for await (const event of events) {
        if (signal?.aborted) break;
        if (event.error) throw new Error(`ElevenLabs: ${event.error.message}`);
        if (event.close) {
          if (event.close.code !== 1000) throw new Error(`ElevenLabs fechou a conexão (${event.close.code}${event.close.reason ? `: ${event.close.reason}` : ''}). Verifique chave, voz, créditos e o formato pcm_16000 no seu plano.`);
          break;
        }
        const message = JSON.parse(event.data.toString());
        if (message.error) throw new Error(`ElevenLabs: ${message.message || message.error}`);
        if (message.audio) yield { audio: Buffer.from(message.audio, 'base64') };
        if (message.isFinal) break;
      }
      if (!signal?.aborted) yield { characters };
    } finally {
      signal?.removeEventListener('abort', abort);
      socket.terminate();
    }
  };
}

export async function listElevenLabsVoices({ apiKey }, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.elevenlabs.io/v2/voices?page_size=100', { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const { voices = [] } = await response.json();
  return voices.map(v => ({ id: v.voice_id, name: v.name, label: [v.name, v.labels?.accent, v.labels?.gender].filter(Boolean).join(' · ') }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/cascade-elevenlabs.test.js`, depois `npm test` e `npm run check`.
Expected: PASS, sem rejeições não tratadas nem processo pendurado.

- [ ] **Step 5: Commit**

```bash
git add src/cascade/elevenlabs.js tests/cascade-elevenlabs.test.js
git commit -m "feat: adaptador de voz e lista de vozes do ElevenLabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sessão e servidor com a arquitetura ElevenLabs

**Files:**
- Modify: `src/cascade/session.js`
- Modify: `src/app.js`
- Test: `tests/cascade-session.test.js`, `tests/app.test.js`

**Interfaces:**
- Consumes: `elevenLabsSettings`, `createElevenLabsSpeaker`, `listElevenLabsVoices` (Task 2); `createAwsAdapters` (existente); config da Task 1.
- Produces:
  - `CascadeSession` passa a `speak` a voz da arquitetura: `cascade.elevenVoiceId` para `elevenlabs`, `cascade.pollyVoiceId` para `polly`.
  - `createSession(config, send, awsSettings, elevenLabs = elevenLabsSettings())`; lança `ValidationError` se faltar chave ou modelo do ElevenLabs.
  - `createApplication({ …, elevenLabs = elevenLabsSettings(), voicesProvider = listElevenLabsVoices })`; `/api/bootstrap` inclui `elevenLabs: { configured: boolean, modelId: string }`; `POST /api/elevenlabs/voices` → `{ voices: [{ id, name, label }] }`.

- [ ] **Step 1: Write the failing tests**

Em `tests/cascade-session.test.js`, adicionar ao fim:

```js
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
```

Em `tests/app.test.js`, adicionar ao fim:

```js
test('ElevenLabs sessions need the key in .env and replace only the speaker', () => {
  const aws = { awsProfile: 'p', region: 'us-east-1' };
  const config = validateConfig({ ...defaults(), pipeline: 'elevenlabs', cascade: { llmModelId: 'us.amazon.nova-micro-v1:0', pollyVoiceId: 'Camila', elevenVoiceId: 'voz123' } }, { requireModel: true });
  assert.throws(() => createSession(config, () => {}, aws, { apiKey: '', modelId: 'eleven_flash_v2_5' }), /ELEVENLABS_API_KEY/);
  const session = createSession(config, () => {}, aws, { apiKey: 'chave', modelId: 'eleven_flash_v2_5' });
  assert.ok(session instanceof CascadeSession);
  assert.equal(session.adapters.speak.name, 'speakWithElevenLabs');
  assert.equal(typeof session.adapters.transcribe, 'function');
  session.abort();
});
test('bootstrap reports ElevenLabs readiness without the key and voices are listed by the server', async t => {
  let used;
  const url = await fixture(t, { elevenLabs: { apiKey: 'segredo', modelId: 'eleven_flash_v2_5' }, voicesProvider: async settings => { used = settings; return [{ id: 'abc', name: 'Bia', label: 'Bia' }]; } });
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).text();
  assert.equal(bootstrap.includes('segredo'), false);
  assert.deepEqual(JSON.parse(bootstrap).elevenLabs, { configured: true, modelId: 'eleven_flash_v2_5' });
  const response = await fetch(`${url}/api/elevenlabs/voices`, { method: 'POST' });
  assert.deepEqual(await response.json(), { voices: [{ id: 'abc', name: 'Bia', label: 'Bia' }] });
  assert.equal(used.apiKey, 'segredo');
  const missing = await fixture(t, { elevenLabs: { apiKey: '', modelId: '' } });
  const refused = await fetch(`${missing}/api/elevenlabs/voices`, { method: 'POST' });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /ELEVENLABS_API_KEY/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cascade-session.test.js tests/app.test.js`
Expected: FAIL (`voiceId` 'Camila' em vez de 'voz123'; `createSession` não lança; rota inexistente).

- [ ] **Step 3: Update `src/cascade/session.js`**

Em `speak()`, trocar `this.adapters.speak(sentences, this.config.cascade.pollyVoiceId, signal)` por:

```js
      const voiceId = this.config.pipeline === 'elevenlabs' ? this.config.cascade.elevenVoiceId : this.config.cascade.pollyVoiceId;
      for await (const part of this.adapters.speak(sentences, voiceId, signal)) {
```

(a linha `const voiceId` fica dentro do `try`, imediatamente antes do `for await`, que substitui o `for await` atual.)

Trocar também o comentário `// Polly abre a conexão junto com o Bedrock…` por `// A voz abre a conexão junto com o Bedrock para o handshake não somar à latência.` e, na mensagem do timeout, `Verifique o modelo e a conexão com a AWS` por `Verifique o modelo e a conexão com os serviços`.

- [ ] **Step 4: Update `src/app.js`**

Adicionar ao import do `config.js` o `ValidationError` já importado (sem mudança) e acrescentar:

```js
import { elevenLabsSettings, createElevenLabsSpeaker, listElevenLabsVoices } from './cascade/elevenlabs.js';
```

Trocar `createSession` por:

```js
export function createSession(config, send, awsSettings, elevenLabs = elevenLabsSettings()) {
  if (config.pipeline === 'sonic') return new SonicSession(config, send, awsSettings);
  if (config.pipeline === 'elevenlabs' && (!elevenLabs.apiKey || !elevenLabs.modelId)) throw new ValidationError('Defina ELEVENLABS_API_KEY e ELEVENLABS_MODEL_ID no .env e reinicie o servidor.');
  const adapters = createAwsAdapters(awsSettings);
  if (config.pipeline === 'elevenlabs') adapters.speak = createElevenLabsSpeaker({ ...elevenLabs, language: config.conversation.language });
  return new CascadeSession(config, send, adapters);
}
```

Na assinatura de `createApplication`, acrescentar `elevenLabs = elevenLabsSettings(), voicesProvider = listElevenLabsVoices` aos parâmetros. Trocar a rota de bootstrap por:

```js
  app.get('/api/bootstrap', (req, res) => res.json({ defaults: defaults(), voices: VOICES, pollyVoices: POLLY_VOICES, aws: awsSettings, elevenLabs: { configured: Boolean(elevenLabs.apiKey), modelId: elevenLabs.modelId } }));
```

Depois da rota `/api/models`, adicionar:

```js
  app.post('/api/elevenlabs/voices', async (req, res) => {
    if (!elevenLabs.apiKey) throw new ValidationError('Defina ELEVENLABS_API_KEY no .env e reinicie o servidor.');
    try { res.json({ voices: await voicesProvider(elevenLabs) }); }
    catch (error) { res.status(502).json({ error: `Não foi possível consultar as vozes do ElevenLabs: ${error.message}` }); }
  });
```

No handler do WebSocket, trocar `session = sessionFactory(config, send, awsSettings);` por:

```js
          session = sessionFactory(config, send, awsSettings, elevenLabs);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/cascade-session.test.js tests/app.test.js`, depois `npm test` e `npm run check`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cascade/session.js src/app.js tests/cascade-session.test.js tests/app.test.js
git commit -m "feat: sessões e rotas da arquitetura ElevenLabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Interface (opção ElevenLabs, voz e consulta de vozes)

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Test: `tests/ui.test.js`

**Interfaces:**
- Consumes: `/api/bootstrap.elevenLabs` e `POST /api/elevenlabs/voices` (Task 3); `cascade.elevenVoiceId` (Task 1).
- Produces: opção `elevenlabs` em `#pipeline`; `#eleven-voice-id`, `#eleven-voice-options`, `#query-eleven-voices`, `#eleven-voice-status`; `data-pipeline` aceita lista separada por espaço (ex.: `"polly elevenlabs"`).

- [ ] **Step 1: Write the failing test**

Em `tests/ui.test.js`, logo antes da linha final `});` do teste, adicionar:

```js
  $('pipeline').value = 'elevenlabs'; $('pipeline').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal($('llm-model-id').disabled, false, 'modelo de texto compartilhado com a cascata');
  assert.equal($('polly-voice-id').disabled, true);
  assert.equal($('eleven-voice-id').disabled, false);
  assert.match($('eleven-voice-status').textContent, /ELEVENLABS_API_KEY/);
  $('eleven-voice-id').value = 'voz123';
  exported = null; $('export-json').click(); await until(() => !!exported);
  const eleven = JSON.parse(await exported.text());
  assert.equal(eleven.pipeline, 'elevenlabs');
  assert.equal(eleven.cascade.elevenVoiceId, 'voz123');
  $('pipeline').value = 'sonic'; $('pipeline').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  $('eleven-voice-id').value = '';
  assert.equal($('config-form').checkValidity(), true, 'voz do ElevenLabs escondida não trava o formulário');
```

(O servidor do teste não tem `ELEVENLABS_API_KEY`, por isso o status mostra a instrução de configurar a chave.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ui.test.js`
Expected: FAIL (não existe a opção `elevenlabs` nem `#eleven-voice-id`).

- [ ] **Step 3: Update `public/index.html`**

Na linha do `#pipeline`, acrescentar a opção e trocar "para as duas" por "para todas":

```html
  <label for="pipeline">Arquitetura</label><select id="pipeline"><option value="sonic">Nova Sonic (fala para fala)</option><option value="polly">Transcribe + Bedrock + Polly</option><option value="elevenlabs">Transcribe + Bedrock + ElevenLabs</option></select>
  <p class="hint">O personagem, as instruções e a espera entre turnos valem para todas. Compare as latências na cabine.</p>
```

No primeiro `.field-row`, depois do bloco `data-pipeline="polly"` da voz do Polly:

```html
    <div data-pipeline="elevenlabs" hidden><label for="eleven-voice-id">Voz do ElevenLabs</label><input id="eleven-voice-id" list="eleven-voice-options" required maxlength="64" placeholder="ID da voz"><datalist id="eleven-voice-options"></datalist></div>
```

Depois da dica `data-pipeline="polly"` da Camila:

```html
  <div class="model-actions" data-pipeline="elevenlabs" hidden><button id="query-eleven-voices" type="button">Consultar vozes do ElevenLabs</button><p id="eleven-voice-status" class="hint" aria-live="polite"></p></div>
  <p class="hint" data-pipeline="elevenlabs" hidden>O texto das respostas é enviado ao ElevenLabs, fora da AWS. Na conta free, cada caractere do Flash v2.5 consome 0,5 crédito.</p>
```

No bloco do modelo de texto, trocar `data-pipeline="polly" hidden` por `data-pipeline="polly elevenlabs" hidden` e a dica dele por:

```html
<p class="hint">A fala é reconhecida pelo Transcribe Streaming e a resposta é falada em 16 kHz pelo Polly ou pelo ElevenLabs.</p>
```

- [ ] **Step 4: Update `public/app.js`**

Em `readConfig()`, trocar a linha de `cascade` por:

```js
    cascade: { llmModelId: $('llm-model-id').value, pollyVoiceId: $('polly-voice-id').value, elevenVoiceId: $('eleven-voice-id').value },
```

Trocar `showPipeline` por:

```js
function showPipeline() { for (const element of document.querySelectorAll('[data-pipeline]')) { element.hidden = !element.dataset.pipeline.split(' ').includes($('pipeline').value); for (const input of element.querySelectorAll('input')) input.disabled = element.hidden; } }
```

Em `applyConfig()`, depois de `$('polly-voice-id').value = c.cascade.pollyVoiceId;`, acrescentar `$('eleven-voice-id').value = c.cascade.elevenVoiceId;`.

No clique de iniciar, trocar as duas linhas de `missingModel` por:

```js
  const cascadePipeline = config.pipeline !== 'sonic';
  const missing = cascadePipeline && !config.cascade.llmModelId.trim() ? ['llm-model-id', 'Informe o modelo de texto do Bedrock antes de iniciar.']
    : config.pipeline === 'elevenlabs' && !config.cascade.elevenVoiceId.trim() ? ['eleven-voice-id', 'Informe a voz do ElevenLabs antes de iniciar.']
      : !cascadePipeline && !config.connection.modelId.trim() ? ['model-id', 'Informe o identificador do modelo Sonic antes de iniciar.'] : null;
  if (missing) { notice(missing[1], true); $(missing[0]).focus(); return; }
```

Depois do handler de `query-models`, adicionar:

```js
$('query-eleven-voices').onclick = async () => {
  const button = $('query-eleven-voices'); button.disabled = true; $('eleven-voice-status').textContent = 'Consultando ElevenLabs…';
  try {
    const result = await api('/api/elevenlabs/voices', { method: 'POST' });
    $('eleven-voice-options').replaceChildren();
    for (const v of result.voices) $('eleven-voice-options').append(new Option(v.label, v.id));
    $('eleven-voice-status').textContent = result.voices.length ? `${result.voices.length} vozes encontradas. Escolha o ID no campo de voz.` : 'Nenhuma voz encontrada na conta.';
  } catch (error) { $('eleven-voice-status').textContent = error.message; notice(error.message, true); }
  finally { button.disabled = false; }
};
```

Em `initialize()`, depois da linha de `pollyVoices`:

```js
    $('eleven-voice-status').textContent = bootstrap.elevenLabs.configured ? `Modelo ${bootstrap.elevenLabs.modelId || 'não definido em ELEVENLABS_MODEL_ID'}.` : 'Defina ELEVENLABS_API_KEY e ELEVENLABS_MODEL_ID no .env e reinicie o servidor.';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/ui.test.js`, depois `npm test` e `npm run check`.
Expected: PASS.

- [ ] **Step 6: Visual check**

Subir uma cópia em outra porta (não mexer no servidor do usuário): `PORT=3002 node --env-file-if-exists=.env src/server.js` em segundo plano; capturar com Edge headless:

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --window-size=1440,900 --virtual-time-budget=4000 --screenshot="$PWD/ui-eleven.png" http://localhost:3002/
```

Encerrar apenas o processo iniciado nesta etapa. Não versionar a imagem.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js tests/ui.test.js
git commit -m "feat: opção ElevenLabs, voz e consulta de vozes na interface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Probe da conta e documentação

**Files:**
- Create: `scripts/probe-elevenlabs.js`
- Modify: `package.json` (script `probe:elevenlabs`)
- Modify: `README.md`

**Interfaces:**
- Consumes: `elevenLabsSettings`, `createElevenLabsSpeaker`, `listElevenLabsVoices` (Task 2).
- Produces: `npm run probe:elevenlabs`.

- [ ] **Step 1: Write `scripts/probe-elevenlabs.js`**

```js
import { elevenLabsSettings, createElevenLabsSpeaker, listElevenLabsVoices } from '../src/cascade/elevenlabs.js';

// Confere chave, vozes, formato pcm_16000 e latência do ElevenLabs sem abrir a interface.
const settings = elevenLabsSettings();
if (!settings.apiKey || !settings.modelId) { console.error('Defina ELEVENLABS_API_KEY e ELEVENLABS_MODEL_ID no .env.'); process.exit(1); }
let voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
try {
  const voices = await listElevenLabsVoices(settings);
  console.log(`ok   vozes: ${voices.length} na conta`);
  for (const v of voices.slice(0, 15)) console.log(`     ${v.id}  ${v.label}`);
  voiceId ||= voices[0]?.id;
  if (!voiceId) throw new Error('nenhuma voz disponível na conta.');
} catch (error) { console.log(`ERRO vozes: ${error.message}`); process.exit(1); }
const started = performance.now(); let first = null; let bytes = 0; let characters = 0;
try {
  async function* texts() { yield 'Olá! Eu sou a voz do teste.'; yield 'Quero saber o prazo de entrega do seu pedido.'; }
  for await (const part of createElevenLabsSpeaker({ ...settings, language: 'pt-BR' })(texts(), voiceId)) {
    if (part.audio) { first ??= performance.now() - started; bytes += part.audio.length; }
    if (part.characters !== undefined) characters = part.characters;
  }
  if (!bytes) throw new Error('nenhum áudio recebido.');
  console.log(`ok   voz ${voiceId} (${settings.modelId}, pcm_16000):`, { primeiroAudioMs: Math.round(first), segundosDeAudio: Number((bytes / 32000).toFixed(2)), caracteres: characters });
} catch (error) { console.log(`ERRO voz ${voiceId}: ${error.message}`); process.exitCode = 1; }
```

Em `package.json`, dentro de `scripts`, depois de `probe:cascade`:

```json
    "probe:elevenlabs": "node --env-file-if-exists=.env scripts/probe-elevenlabs.js"
```

(acrescentar a vírgula na linha anterior).

- [ ] **Step 2: Update `README.md`**

Depois da seção "### Transcribe + Bedrock + Polly", adicionar:

````markdown
### Transcribe + Bedrock + ElevenLabs

Terceira arquitetura: igual à do Polly, com a voz gerada pelo ElevenLabs (WebSocket `stream-input`, PCM 16 kHz, frase a frase). Detalhes em `docs/elevenlabs-cascade-design.md`.

Crie uma conta (a free basta para testar: 10 mil créditos por mês, e cada caractere do Flash v2.5 consome 0,5 crédito), gere uma chave de API e preencha o `.env`:

```dotenv
ELEVENLABS_API_KEY=<sua_chave>
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_VOICE_ID=<id_da_voz>
```

A chave fica só no servidor; a tela mostra apenas se ela está configurada. Para listar as vozes da conta e medir a latência:

```powershell
npm run probe:elevenlabs
```

Na tela, escolha **Transcribe + Bedrock + ElevenLabs**, use **Consultar vozes do ElevenLabs** e informe o ID da voz. O texto das respostas é enviado ao ElevenLabs, fora da AWS; na conta free não há direito de uso comercial.
````

Em "## Arquivos e dados", na linha de `src/cascade/`, acrescentar `elevenlabs.js` voz e vozes do ElevenLabs; e adicionar:

```markdown
- `scripts/probe-elevenlabs.js`: verificação da chave, vozes, formato e latência do ElevenLabs.
```

- [ ] **Step 3: Run checks**

Run: `npm test` e `npm run check`.
Expected: PASS.

- [ ] **Step 4: Run the probe (only if the key exists)**

Se `.env` tiver `ELEVENLABS_API_KEY` preenchida: acrescentar `ELEVENLABS_MODEL_ID=eleven_flash_v2_5` ao `.env` se ausente e rodar `npm run probe:elevenlabs` uma vez. Se a chave não existir, registrar no relatório que o probe fica pendente. Nunca imprimir a chave.

- [ ] **Step 5: Commit**

```bash
git add scripts/probe-elevenlabs.js package.json README.md
git commit -m "docs: probe e instruções do ElevenLabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Real conversation (manual, with the user)**

Com fones e a chave configurada: arquitetura "Transcribe + Bedrock + ElevenLabs", 5 a 10 turnos, conferir voz, transcrição, latências e interrupção; comparar com Polly e Sonic.

## Ledger

- 2026-10-06: plano escrito com base na documentação pública do ElevenLabs; sem chave na conta ainda, nenhum teste real feito.
