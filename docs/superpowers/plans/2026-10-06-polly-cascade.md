# Transcribe + Bedrock + Polly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar a arquitetura "Transcribe + Bedrock + Polly" ao Sonic Studio, selecionável por configuração, com as mesmas métricas de latência do Nova Sonic.

**Architecture:** Uma `CascadeSession` com a mesma interface da `SonicSession` (`start/audio/stop/abort`) orquestra três adaptadores injetáveis: Transcribe Streaming (fala→texto), Bedrock ConverseStream (texto→resposta) e Polly StartSpeechSynthesisStream (resposta→voz PCM 16 kHz). Fim de turno, agrupamento em frases e alinhamento de PCM ficam em funções puras testáveis. `app.js` escolhe a sessão pelo campo `pipeline` da configuração; o protocolo WebSocket com o navegador não muda.

**Tech Stack:** Node.js 22+, Express 5, ws, AWS SDK v3 (`@aws-sdk/client-transcribe-streaming`, `@aws-sdk/client-polly`, `@aws-sdk/client-bedrock-runtime`), `node:test`, jsdom.

**Spec:** `docs/polly-cascade-design.md`

## Global Constraints

- Branch: `feat/polly-cascade`. Todo commit termina com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Versão das dependências AWS novas: `^3.1146.0` (igual ao `client-bedrock-runtime` instalado).
- Polly: `Engine: 'generative'`, `OutputFormat: 'pcm'`, `SampleRate: '16000'`. 24000 é rejeitado pelo serviço.
- Voz padrão do Polly: `Camila` (única generativa pt-BR na conta).
- Espera de fim de turno: `HIGH` 400 ms, `MEDIUM` 700 ms, `LOW` 1100 ms; texto estável há 250 ms.
- `schemaVersion` continua `1`. JSON sem `pipeline`/`cascade` abre como `sonic`.
- Nenhum modelo escolhido em código: o padrão do modelo de texto vem de `CASCADE_LLM_MODEL_ID` no `.env`.
- Modelos com `anthropic` no ID não recebem `topP`.
- Interface em português, frases em caixa normal; mensagens de erro dizem o que fazer.
- Estilo do repositório: módulos ES, funções curtas, poucas linhas em branco, nomes em inglês no código e textos em português.
- Testes não chamam a AWS. `npm test` e `npm run check` passam ao fim de cada tarefa.

## Review Focus

- Resultado final atrasado do Transcribe (chega ~1,5 s depois) para uma fala já respondida: não pode interromper a resposta nem abrir outro turno. Testes: Task 2 (detector) e Task 4 (interrupção).
- "Permitir interromper" desligado: fala durante a resposta não cancela nada e vira o próximo turno. Teste: Task 4 (sem interrupção).
- Duas falas do usuário sem resposta entre elas (LLM devolveu texto vazio): o histórico une as falas para manter a alternância exigida pelo Converse. Teste: Task 4 (sem interrupção).
- Erro do Bedrock ou do Polly no meio do turno (AccessDenied, throttling): a sessão termina com a mensagem original visível. Teste: Task 4 (falha do Bedrock).
- Encerrar a conversa enquanto um turno está sendo gerado: LLM e Polly são cancelados sem erro nem rejeição não tratada. Teste: Task 4 (sem interrupção).

---

### Task 1: Configuração com arquitetura e grupo `cascade`

**Files:**
- Modify: `src/config.js`
- Modify: `src/app.js` (rota `/api/bootstrap`)
- Modify: `.env.example`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `PIPELINES = ['sonic', 'polly']`; `POLLY_VOICES: {id, label}[]`; `defaults()` com `pipeline: 'sonic'` e `cascade: { llmModelId, pollyVoiceId }`; `validateConfig(input, { requireModel })` exige `connection.modelId` quando `pipeline === 'sonic'` e `cascade.llmModelId` quando `pipeline === 'polly'`; retorna sempre `pipeline` e `cascade`. `/api/bootstrap` passa a incluir `pollyVoices`.

- [ ] **Step 1: Write the failing test**

Adicionar ao fim de `tests/config.test.js`:

```js
test('legacy files open as Sonic and each pipeline requires its own model', () => {
  const legacy = defaults(); delete legacy.pipeline; delete legacy.cascade;
  const loaded = validateConfig(legacy);
  assert.equal(loaded.pipeline, 'sonic');
  assert.equal(loaded.cascade.pollyVoiceId, 'Camila');
  assert.throws(() => validateConfig({ ...defaults(), pipeline: 'gpt' }), /arquitetura/i);
  assert.throws(() => validateConfig({ ...defaults(), cascade: { ...defaults().cascade, apiKey: 'x' } }), /campo/i);
  const polly = { ...defaults(), pipeline: 'polly', connection: { modelId: '' }, cascade: { llmModelId: '', pollyVoiceId: 'Camila' } };
  assert.throws(() => validateConfig(polly, { requireModel: true }), /modelo de texto/i);
  const ready = validateConfig({ ...polly, cascade: { llmModelId: ' us.amazon.nova-2-lite-v1:0 ', pollyVoiceId: 'Camila' } }, { requireModel: true });
  assert.equal(ready.connection.modelId, '');
  assert.deepEqual(ready.cascade, { llmModelId: 'us.amazon.nova-2-lite-v1:0', pollyVoiceId: 'Camila' });
  assert.throws(() => validateConfig({ ...defaults(), connection: { modelId: '' } }, { requireModel: true }), /modelo/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL em `loaded.pipeline` (`undefined !== 'sonic'`).

- [ ] **Step 3: Write minimal implementation**

Em `src/config.js`, depois de `VOICES`:

```js
export const PIPELINES = ['sonic', 'polly'];
export const POLLY_VOICES = [{ id: 'Camila', label: 'Camila · Português brasileiro (generativa)' }];
```

Em `defaults()`, entre `name` e `character`, e entre `connection` e `conversation`:

```js
    pipeline: 'sonic',
```

```js
    cascade: { llmModelId: process.env.CASCADE_LLM_MODEL_ID || '', pollyVoiceId: 'Camila' },
```

Em `validateConfig`, substituir o bloco do início até `const connection = {...};` por:

```js
  object(input, ['schemaVersion', 'id', 'createdAt', 'updatedAt', 'name', 'pipeline', 'character', 'connection', 'cascade', 'conversation'], 'configuração');
  if (input.schemaVersion !== 1) fail('Versão de configuração não suportada.');
  const pipeline = input.pipeline ?? 'sonic';
  if (!PIPELINES.includes(pipeline)) fail('Arquitetura inválida.');
  object(input.character, ['name', 'avatar'], 'personagem');
  object(input.connection, ['awsProfile', 'region', 'modelId'], 'conexão');
  // Arquivos anteriores à arquitetura em cascata não têm o grupo cascade.
  const cascade = input.cascade ?? defaults().cascade;
  object(cascade, ['llmModelId', 'pollyVoiceId'], 'cascata');
  object(input.conversation, ['voiceId', 'language', 'systemPrompt', 'endpointingSensitivity', 'allowInterruption', 'temperature', 'topP', 'maxTokens'], 'conversa');
  const connection = {
    modelId: string(input.connection.modelId, 'Identificador do modelo', 200, !(requireModel && pipeline === 'sonic')),
  };
```

E no objeto retornado, trocar as linhas de `name` até `connection,` por:

```js
    schemaVersion: 1, name: string(input.name, 'Nome da configuração', 100), pipeline,
    character: { name: string(input.character.name, 'Nome do personagem', 80), avatar: validateAvatar(input.character.avatar) },
    connection,
    cascade: {
      llmModelId: string(cascade.llmModelId, 'Modelo de texto', 200, !(requireModel && pipeline === 'polly')),
      pollyVoiceId: string(cascade.pollyVoiceId, 'Voz do Polly', 40),
    },
```

Em `src/app.js`, trocar o import e a rota de bootstrap:

```js
import { defaults, validateConfig, ValidationError, VOICES, POLLY_VOICES } from './config.js';
```

```js
  app.get('/api/bootstrap', (req, res) => res.json({ defaults: defaults(), voices: VOICES, pollyVoices: POLLY_VOICES, aws: awsSettings }));
```

Em `.env.example`, adicionar ao fim:

```dotenv
# Modelo de texto da arquitetura Transcribe + Bedrock + Polly (inference profile).
CASCADE_LLM_MODEL_ID=us.amazon.nova-2-lite-v1:0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS em todos (23 testes).

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/app.js .env.example tests/config.test.js
git commit -m "feat: campo pipeline e grupo cascade na configuração

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Peças puras da cascata (fim de turno, frases, PCM)

**Files:**
- Create: `src/cascade/turn.js`
- Test: `tests/cascade-turn.test.js`

**Interfaces:**
- Consumes: `voiceLevel(ArrayBuffer): number` e `VOICE_THRESHOLD` de `public/metrics.js`.
- Produces:
  - `ENDPOINT_MS = { HIGH: 400, MEDIUM: 700, LOW: 1100 }`
  - `class TurnDetector(endpointMs, settleMs = 250)` com `audio(bytes: Buffer, now: number): boolean`, `transcript(id: string, text: string, now: number): boolean` (false quando o `id` já foi respondido), getter `text: string`, `poll(now: number): string | null` (devolve o texto do turno e marca os IDs como respondidos).
  - `class SentenceChunker(minChars = 12)` com `push(delta: string): string[]` e `flush(): string[]`.
  - `class PcmAligner` com `push(chunk: Uint8Array): Buffer` (sempre comprimento par).

- [ ] **Step 1: Write the failing test**

Criar `tests/cascade-turn.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDetector, SentenceChunker, PcmAligner, ENDPOINT_MS } from '../src/cascade/turn.js';

const loud = () => Buffer.from(new Int16Array(512).fill(8000).buffer);

test('turn detector waits for mic silence and a stable transcript, then ignores answered results', () => {
  assert.deepEqual(ENDPOINT_MS, { HIGH: 400, MEDIUM: 700, LOW: 1100 });
  const d = new TurnDetector(700, 250);
  assert.equal(d.poll(0), null);
  assert.equal(d.audio(loud(), 0), true);
  assert.equal(d.transcript('a', 'Olá', 50), true);
  d.audio(loud(), 300); d.transcript('a', 'Olá tudo bem', 400);
  assert.equal(d.audio(Buffer.alloc(1024), 600), false);
  assert.equal(d.poll(900), null, 'silêncio de 600 ms');
  assert.equal(d.poll(1000), 'Olá tudo bem');
  assert.equal(d.transcript('a', 'Olá, tudo bem?', 1500), false, 'final atrasado de fala já respondida');
  assert.equal(d.poll(5000), null);
  d.transcript('b', 'Oi', 5100);
  assert.equal(d.poll(5300), null, 'sem voz medida, a espera conta a partir do texto');
  assert.equal(d.poll(5800), 'Oi');
});

test('sentence chunker cuts at punctuation once a sentence is long enough', () => {
  const c = new SentenceChunker(12);
  assert.deepEqual(c.push('Oi. '), []);
  assert.deepEqual(c.push('Tudo bem com você? Eu'), ['Oi. Tudo bem com você? ']);
  assert.deepEqual(c.push(' posso ajudar'), []);
  assert.deepEqual(c.flush(), ['Eu posso ajudar']);
  assert.deepEqual(c.flush(), []);
});

test('PCM aligner keeps 16-bit samples whole across chunks', () => {
  const p = new PcmAligner();
  assert.deepEqual([...p.push(Uint8Array.of(1, 2, 3))], [1, 2]);
  assert.deepEqual([...p.push(Uint8Array.of(4))], [3, 4]);
  assert.equal(p.push(Uint8Array.of()).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cascade-turn.test.js`
Expected: FAIL com `Cannot find module '.../src/cascade/turn.js'`.

- [ ] **Step 3: Write minimal implementation**

Criar `src/cascade/turn.js`:

```js
import { voiceLevel, VOICE_THRESHOLD } from '../../public/metrics.js';

// Silêncio no microfone que encerra o turno, por opção de "Espera entre turnos".
export const ENDPOINT_MS = { HIGH: 400, MEDIUM: 700, LOW: 1100 };

// O final do Transcribe chega ~1,5 s após a fala; o turno termina antes, por silêncio e texto parcial estável.
export class TurnDetector {
  constructor(endpointMs, settleMs = 250) { this.endpointMs = endpointMs; this.settleMs = settleMs; this.answered = new Set(); this.clear(); }
  clear() { this.segments = new Map(); this.lastVoiceAt = null; this.lastTextAt = null; }
  audio(bytes, now) {
    const voiced = voiceLevel(Uint8Array.from(bytes).buffer) >= VOICE_THRESHOLD;
    if (voiced) this.lastVoiceAt = now;
    return voiced;
  }
  transcript(id, text, now) {
    if (this.answered.has(id)) return false;
    this.segments.set(id, text); this.lastTextAt = now;
    return true;
  }
  get text() { return [...this.segments.values()].join(' ').trim(); }
  poll(now) {
    const text = this.text;
    if (!text) return null;
    const silenceSince = this.lastVoiceAt ?? this.lastTextAt;
    if (now - silenceSince < this.endpointMs || now - this.lastTextAt < this.settleMs) return null;
    for (const id of this.segments.keys()) this.answered.add(id);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/cascade-turn.test.js` e depois `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cascade/turn.js tests/cascade-turn.test.js
git commit -m "feat: detector de fim de turno, frases e alinhamento PCM da cascata

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Adaptadores AWS (Transcribe, Bedrock, Polly)

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)
- Create: `src/cascade/aws.js`
- Test: `tests/cascade-aws.test.js`

**Interfaces:**
- Consumes: `defaults()` (só no teste).
- Produces:
  - `TRANSCRIBE_LANGUAGES: Record<language, string>`
  - `inferenceConfig(modelId: string, conversation): { maxTokens, temperature, topP? }`
  - `createAwsAdapters(awsSettings, clients?)` → objeto com:
    - `transcribe(audio: AsyncIterable<Buffer>, language: string, signal?: AbortSignal)` → async iterável de `{ id: string, text: string, partial: boolean }`
    - `reply({ modelId, system: string, messages, conversation }, signal?)` → async iterável de `{ text }` ou `{ usage: { inputTokens, outputTokens } }`
    - `speak(texts: AsyncIterable<string>, voiceId: string, signal?)` → async iterável de `{ audio: Uint8Array }` ou `{ characters: number }`
    - `destroy(): void`

- [ ] **Step 1: Install dependencies**

Run: `npm install @aws-sdk/client-polly@^3.1146.0 @aws-sdk/client-transcribe-streaming@^3.1146.0`
Expected: `package.json` lista as duas dependências.

- [ ] **Step 2: Write the failing test**

Criar `tests/cascade-aws.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/config.js';
import { createAwsAdapters, inferenceConfig } from '../src/cascade/aws.js';

async function* from(items) { for (const item of items) yield item; }
async function collect(iterable) { const items = []; for await (const item of iterable) items.push(item); return items; }

test('inference config omits topP for Anthropic models', () => {
  const c = defaults().conversation;
  assert.deepEqual(inferenceConfig('us.amazon.nova-2-lite-v1:0', c), { maxTokens: 1024, temperature: 0.7, topP: 0.9 });
  assert.deepEqual(inferenceConfig('us.anthropic.claude-haiku-4-5-20251001-v1:0', c), { maxTokens: 1024, temperature: 0.7 });
});

test('adapters map Transcribe, Converse and Polly streams', async () => {
  const commands = [];
  const fake = output => ({ send: async command => { commands.push(command); return output; }, destroy() {} });
  const adapters = createAwsAdapters({ awsProfile: 'p', region: 'us-east-1' }, {
    transcribe: fake({ TranscriptResultStream: from([{ TranscriptEvent: { Transcript: { Results: [
      { ResultId: 'r', IsPartial: true, Alternatives: [{ Transcript: 'Oi' }] },
      { ResultId: 'x', IsPartial: false, Alternatives: [{ Transcript: '' }] },
    ] } } }]) }),
    bedrock: fake({ stream: from([{ contentBlockDelta: { delta: { text: 'Olá' } } }, { metadata: { usage: { inputTokens: 3, outputTokens: 1 } } }]) }),
    polly: fake({ EventStream: from([{ AudioEvent: { AudioChunk: Uint8Array.of(1, 2) } }, { StreamClosedEvent: { RequestCharacters: 4 } }]) }),
  });
  assert.deepEqual(await collect(adapters.transcribe(from([Buffer.alloc(2)]), 'es')), [{ id: 'r', text: 'Oi', partial: true }]);
  const transcribe = commands[0].input;
  assert.deepEqual([transcribe.LanguageCode, transcribe.MediaEncoding, transcribe.MediaSampleRateHertz], ['es-US', 'pcm', 16000]);
  assert.deepEqual(await collect(transcribe.AudioStream), [{ AudioEvent: { AudioChunk: Buffer.alloc(2) } }]);
  const request = { modelId: 'us.amazon.nova-2-lite-v1:0', system: 'S', messages: [{ role: 'user', content: [{ text: 'Oi' }] }], conversation: defaults().conversation };
  assert.deepEqual(await collect(adapters.reply(request)), [{ text: 'Olá' }, { usage: { inputTokens: 3, outputTokens: 1 } }]);
  assert.deepEqual(commands[1].input.system, [{ text: 'S' }]);
  assert.equal(commands[1].input.inferenceConfig.topP, 0.9);
  assert.deepEqual(await collect(adapters.speak(from(['Oi.']), 'Camila')), [{ audio: Uint8Array.of(1, 2) }, { characters: 4 }]);
  const polly = commands[2].input;
  assert.deepEqual([polly.Engine, polly.VoiceId, polly.OutputFormat, polly.SampleRate], ['generative', 'Camila', 'pcm', '16000']);
  assert.deepEqual(await collect(polly.ActionStream), [{ TextEvent: { Text: 'Oi.', FlushStreamConfiguration: { Force: true } } }, { CloseStreamEvent: {} }]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/cascade-aws.test.js`
Expected: FAIL com `Cannot find module '.../src/cascade/aws.js'`.

- [ ] **Step 4: Write minimal implementation**

Criar `src/cascade/aws.js`:

```js
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from '@aws-sdk/client-transcribe-streaming';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, StartSpeechSynthesisStreamCommand } from '@aws-sdk/client-polly';
import { fromIni } from '@aws-sdk/credential-providers';

export const TRANSCRIBE_LANGUAGES = { 'pt-BR': 'pt-BR', 'en-US': 'en-US', es: 'es-US', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', hi: 'hi-IN' };

// Claude 4.5 recusa temperature e topP juntos (ValidationException confirmada na conta).
export function inferenceConfig(modelId, c) {
  const config = { maxTokens: c.maxTokens, temperature: c.temperature };
  return /anthropic/.test(modelId) ? config : { ...config, topP: c.topP };
}

function createClients({ region, awsProfile }) {
  const options = { region, credentials: fromIni({ profile: awsProfile }), maxAttempts: 1 };
  return { transcribe: new TranscribeStreamingClient(options), bedrock: new BedrockRuntimeClient(options), polly: new PollyClient(options) };
}

export function createAwsAdapters(awsSettings, clients = createClients(awsSettings)) {
  return {
    async *transcribe(audio, language, signal) {
      const AudioStream = (async function* () { for await (const chunk of audio) yield { AudioEvent: { AudioChunk: chunk } }; })();
      const response = await clients.transcribe.send(new StartStreamTranscriptionCommand({ LanguageCode: TRANSCRIBE_LANGUAGES[language], MediaEncoding: 'pcm', MediaSampleRateHertz: 16000, AudioStream }), { abortSignal: signal });
      for await (const event of response.TranscriptResultStream) {
        for (const result of event.TranscriptEvent?.Transcript?.Results || []) {
          const text = result.Alternatives?.[0]?.Transcript;
          if (text) yield { id: result.ResultId, text, partial: Boolean(result.IsPartial) };
        }
      }
    },
    async *reply({ modelId, system, messages, conversation }, signal) {
      const response = await clients.bedrock.send(new ConverseStreamCommand({ modelId, system: [{ text: system }], messages, inferenceConfig: inferenceConfig(modelId, conversation) }), { abortSignal: signal });
      for await (const event of response.stream) {
        if (event.contentBlockDelta?.delta?.text) yield { text: event.contentBlockDelta.delta.text };
        else if (event.metadata?.usage) yield { usage: { inputTokens: event.metadata.usage.inputTokens, outputTokens: event.metadata.usage.outputTokens } };
      }
    },
    async *speak(texts, voiceId, signal) {
      const ActionStream = (async function* () {
        for await (const text of texts) yield { TextEvent: { Text: text, FlushStreamConfiguration: { Force: true } } };
        yield { CloseStreamEvent: {} };
      })();
      const response = await clients.polly.send(new StartSpeechSynthesisStreamCommand({ Engine: 'generative', VoiceId: voiceId, OutputFormat: 'pcm', SampleRate: '16000', ActionStream }), { abortSignal: signal });
      for await (const event of response.EventStream) {
        if (event.AudioEvent?.AudioChunk) yield { audio: event.AudioEvent.AudioChunk };
        else if (event.StreamClosedEvent) yield { characters: event.StreamClosedEvent.RequestCharacters };
        else {
          const [name, value] = Object.entries(event)[0] || [];
          if (name?.endsWith('Exception')) throw new Error(`${name}: ${value?.message || 'falha no Polly.'}`);
        }
      }
    },
    destroy() { for (const client of Object.values(clients)) client.destroy(); },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/cascade-aws.test.js` e depois `npm test` e `npm run check`
Expected: PASS; "Sintaxe JavaScript verificada." (o `check.js` só varre `src/`, `public/` e `scripts/` no primeiro nível; `src/cascade/` é coberto pelos testes que importam os módulos).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/cascade/aws.js tests/cascade-aws.test.js
git commit -m "feat: adaptadores de Transcribe, Bedrock e Polly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `CascadeSession` (orquestração de turnos)

**Files:**
- Modify: `src/sonic.js` (extrair `systemText`)
- Create: `src/cascade/session.js`
- Test: `tests/cascade-session.test.js`

**Interfaces:**
- Consumes: `EventQueue` de `src/sonic.js`; `TurnDetector`, `SentenceChunker`, `PcmAligner`, `ENDPOINT_MS` (Task 2); adaptadores com a forma de `createAwsAdapters` (Task 3); configuração validada com `cascade` (Task 1).
- Produces:
  - `systemText(config): string` exportado de `src/sonic.js`.
  - `class CascadeSession(config, send, adapters, { now = () => performance.now(), pollMs = 50 } = {})` com `start(): Promise<void>`, `audio(bytes: Buffer)`, `poll()`, `stop()`, `abort()`; propriedades observáveis `history`, `turn`, `pending: Promise | null`, `error`.
  - Mensagens enviadas ao navegador: `ready`; `transcript {id, role: 'USER'|'ASSISTANT', text}` (texto do assistente em deltas); `audio {audio: base64, sampleRate: 16000}`; `interrupted`; `latency {source: 'model', ms, stages: {llm, tts}}`; `usage {inputTokens, outputTokens, ttsCharacters}`.

- [ ] **Step 1: Write the failing tests**

Criar `tests/cascade-session.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cascade-session.test.js`
Expected: FAIL com `Cannot find module '.../src/cascade/session.js'`.

- [ ] **Step 3: Extract `systemText` in `src/sonic.js`**

Depois da constante `languages`, adicionar:

```js
export function systemText(config) {
  return `Seu nome é ${config.character.name}. Responda em ${languages[config.conversation.language]}.\n${config.conversation.systemPrompt}`;
}
```

E na linha do `textInput` em `SonicProtocol.start()`, trocar o template literal por `content: systemText(this.config)`:

```js
      event('textInput', { promptName: this.promptName, contentName: this.textName, content: systemText(this.config) }),
```

Run: `node --test tests/sonic.test.js`
Expected: PASS (o teste existente confere `português brasileiro` no texto).

- [ ] **Step 4: Write `src/cascade/session.js`**

```js
import { EventQueue, systemText } from '../sonic.js';
import { TurnDetector, SentenceChunker, PcmAligner, ENDPOINT_MS } from './turn.js';

const MAX_MESSAGES = 20;
const SPOKEN_OUTPUT = '\nSuas respostas serão faladas em voz alta: use frases curtas, sem markdown, listas, emojis ou URLs.';

export class CascadeSession {
  constructor(config, send, adapters, { now = () => performance.now(), pollMs = 50 } = {}) {
    this.config = config; this.send = send; this.adapters = adapters; this.now = now; this.pollMs = pollMs;
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
    try {
      // Polly abre a conexão junto com o Bedrock para o handshake não somar à latência.
      await Promise.allSettled([this.generate(turn, n, sentences, signal), this.speak(turn, sentences, signal)]);
      if (turn.failure) throw turn.failure;
    } finally {
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
      for await (const part of this.adapters.speak(sentences, this.config.cascade.pollyVoiceId, signal)) {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/cascade-session.test.js` e depois `npm test`
Expected: PASS nos 4 testes novos e em todos os anteriores.

- [ ] **Step 6: Commit**

```bash
git add src/sonic.js src/cascade/session.js tests/cascade-session.test.js
git commit -m "feat: sessão em cascata com fim de turno, interrupção e métricas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Escolha da sessão por arquitetura no servidor

**Files:**
- Modify: `src/app.js`
- Test: `tests/app.test.js`

**Interfaces:**
- Consumes: `CascadeSession` (Task 4), `createAwsAdapters` (Task 3), `SonicSession`.
- Produces: `createSession(config, send, awsSettings)` exportado de `src/app.js`, usado como `sessionFactory` padrão.

- [ ] **Step 1: Write the failing tests**

Em `tests/app.test.js`, trocar os imports do topo por:

```js
import { createApplication, createSession } from '../src/app.js';
import { defaults, validateConfig } from '../src/config.js';
import { SonicSession } from '../src/sonic.js';
import { CascadeSession } from '../src/cascade/session.js';
```

E adicionar ao fim:

```js
test('session factory picks the pipeline chosen in the configuration', () => {
  const aws = { awsProfile: 'p', region: 'us-east-1' };
  const sonic = defaults(); sonic.connection.modelId = 'amazon.nova-2-sonic-v1:0';
  assert.ok(createSession(validateConfig(sonic, { requireModel: true }), () => {}, aws) instanceof SonicSession);
  const polly = { ...defaults(), pipeline: 'polly', cascade: { llmModelId: 'us.amazon.nova-2-lite-v1:0', pollyVoiceId: 'Camila' } };
  const session = createSession(validateConfig(polly, { requireModel: true }), () => {}, aws);
  assert.ok(session instanceof CascadeSession);
  session.abort();
});
test('Polly pipeline needs a Bedrock text model before creating a session', async t => {
  let created = false;
  const url = await fixture(t, { sessionFactory: () => { created = true; } });
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { origin: url });
  await once(ws, 'open'); const message = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'start', config: { ...defaults(), pipeline: 'polly', cascade: { llmModelId: '', pollyVoiceId: 'Camila' } } }));
  const reply = JSON.parse((await message)[0]);
  assert.equal(reply.type, 'error');
  assert.match(reply.message, /modelo de texto/i);
  assert.equal(created, false);
  ws.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/app.test.js`
Expected: FAIL com `does not provide an export named 'createSession'`.

- [ ] **Step 3: Write minimal implementation**

Em `src/app.js`, adicionar aos imports:

```js
import { CascadeSession } from './cascade/session.js';
import { createAwsAdapters } from './cascade/aws.js';
```

Antes de `createApplication`:

```js
export function createSession(config, send, awsSettings) {
  return config.pipeline === 'polly' ? new CascadeSession(config, send, createAwsAdapters(awsSettings)) : new SonicSession(config, send, awsSettings);
}
```

E na assinatura de `createApplication`, trocar o padrão de `sessionFactory`:

```js
sessionFactory = createSession,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` e `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js tests/app.test.js
git commit -m "feat: servidor escolhe Sonic ou cascata pela configuração

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Interface (seletor de arquitetura, campos da cascata, etapas)

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `tests/ui.test.js`

**Interfaces:**
- Consumes: `/api/bootstrap` com `pollyVoices` (Task 1); mensagens `latency` com `stages` e `usage` com `ttsCharacters` (Task 4).
- Produces: elementos `#pipeline`, `#polly-voice-id`, `#polly-voice-options`, `#llm-model-id`, `#llm-options`, `#stages`; blocos `[data-pipeline="sonic"]` e `[data-pipeline="polly"]` alternados por `showPipeline()`.

- [ ] **Step 1: Write the failing test**

Em `tests/ui.test.js`, antes da linha final `});` do teste, adicionar:

```js
  $('pipeline').value = 'polly'; $('pipeline').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const doc = dom.window.document;
  assert.equal(doc.querySelector('[data-pipeline="sonic"]').hidden, true);
  assert.equal(doc.querySelector('[data-pipeline="polly"]').hidden, false);
  assert.equal($('polly-voice-options').options[0].value, 'Camila');
  $('llm-model-id').value = 'us.amazon.nova-micro-v1:0';
  exported = null; $('export-json').click(); await until(() => !!exported);
  const cascade = JSON.parse(await exported.text());
  assert.equal(cascade.pipeline, 'polly');
  assert.deepEqual(cascade.cascade, { llmModelId: 'us.amazon.nova-micro-v1:0', pollyVoiceId: 'Camila' });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ui.test.js`
Expected: FAIL com `Cannot set properties of null (setting 'value')` (não existe `#pipeline`).

- [ ] **Step 3: Update `public/index.html`**

Logo após `<h2 id="settings-title">Voz e comportamento</h2>`:

```html
  <label for="pipeline">Arquitetura</label><select id="pipeline"><option value="sonic">Nova Sonic (fala para fala)</option><option value="polly">Transcribe + Bedrock + Polly</option></select>
  <p class="hint">O personagem, as instruções e a espera entre turnos valem para as duas. Compare as latências na cabine.</p>
```

Trocar o primeiro `<div>` do primeiro `.field-row` (o da voz) e a dica de vozes por:

```html
    <div data-pipeline="sonic"><label for="voice-id">Voz</label><input id="voice-id" list="voice-options" required maxlength="80" value="carolina"><datalist id="voice-options"></datalist></div>
    <div data-pipeline="polly" hidden><label for="polly-voice-id">Voz do Polly</label><input id="polly-voice-id" list="polly-voice-options" required maxlength="40" value="Camila"><datalist id="polly-voice-options"></datalist></div>
```

```html
  <p class="hint" data-pipeline="sonic">Carolina e Leo falam português no Nova 2 Sonic. Confirme as vozes do modelo escolhido.</p>
  <p class="hint" data-pipeline="polly" hidden>Camila é a única voz generativa em português brasileiro no Polly.</p>
```

Dentro de `<details open><summary>Modelo e conta AWS</summary>`, envolver o campo `model-id`, seu datalist e o `.model-actions` em `<div data-pipeline="sonic">…</div>` e adicionar, antes de `<p id="aws-info">`:

```html
    <div data-pipeline="polly" hidden><label for="llm-model-id">Modelo de texto (Bedrock)</label><input id="llm-model-id" list="llm-options" maxlength="200" placeholder="Informe o inference profile"><datalist id="llm-options"><option value="us.amazon.nova-micro-v1:0">Nova Micro (primeiro token mais rápido)</option><option value="us.amazon.nova-2-lite-v1:0">Nova 2 Lite</option><option value="us.anthropic.claude-haiku-4-5-20251001-v1:0">Claude Haiku 4.5</option></datalist><p class="hint">A fala é reconhecida pelo Transcribe Streaming e a resposta é falada pelo Polly generativo em 16 kHz.</p></div>
```

Na cabine, logo depois do `</dl>` das métricas:

```html
  <p id="stages" class="booth-hint"></p>
```

- [ ] **Step 4: Update `public/app.js`**

Em `readConfig()`, depois de `schemaVersion: 1, name: $('config-name').value,`:

```js
    pipeline: $('pipeline').value,
```

e depois de `connection: { modelId: $('model-id').value },`:

```js
    cascade: { llmModelId: $('llm-model-id').value, pollyVoiceId: $('polly-voice-id').value },
```

Antes de `function updatePreview()`:

```js
function showPipeline() { for (const element of document.querySelectorAll('[data-pipeline]')) element.hidden = element.dataset.pipeline !== $('pipeline').value; }
```

Em `updatePreview()`, como primeira linha do corpo:

```js
  showPipeline();
```

e trocar a linha de `preview-language` por:

```js
    $('preview-language').textContent = `${$('language').selectedOptions[0].textContent}, ${$('pipeline').selectedOptions[0].textContent}`;
```

Em `applyConfig()`, depois de `$('model-id').value = c.connection.modelId;`:

```js
  $('pipeline').value = c.pipeline; $('llm-model-id').value = c.cascade.llmModelId; $('polly-voice-id').value = c.cascade.pollyVoiceId;
```

No clique de iniciar, trocar a linha que confere `config.connection.modelId` por:

```js
  const missingModel = config.pipeline === 'polly' ? !config.cascade.llmModelId.trim() && 'llm-model-id' : !config.connection.modelId.trim() && 'model-id';
  if (missingModel) { notice(config.pipeline === 'polly' ? 'Informe o modelo de texto do Bedrock antes de iniciar.' : 'Informe o identificador do modelo Sonic antes de iniciar.', true); $(missingModel).focus(); return; }
```

Na linha `latency = new LatencyLog(); renderLatency();` do início da conversa, acrescentar `$('stages').textContent = '';`.

No `ws.onmessage`, trocar os ramos de `latency` e `usage` por:

```js
        else if (message.type === 'latency') {
          recordLatency(message.source, message.ms);
          if (message.stages) $('stages').textContent = `Último turno: primeiro texto em ${message.stages.llm} ms, voz ${message.stages.tts} ms depois da primeira frase.`;
        }
        else if (message.type === 'usage') $('usage').textContent = `Tokens: ${message.inputTokens ?? '—'} de entrada, ${message.outputTokens ?? '—'} de saída${message.ttsCharacters === undefined ? '' : `, ${message.ttsCharacters} caracteres de voz`}`;
```

No `clear-transcript`, acrescentar `$('stages').textContent = '';` junto de `$('usage').textContent = '';`.

Em `initialize()`, depois da linha de `bootstrap.voices.forEach(...)`:

```js
    bootstrap.pollyVoices.forEach(v => $('polly-voice-options').append(new Option(v.label, v.id)));
```

- [ ] **Step 5: Update `public/styles.css`**

Depois da regra `.visually-hidden`:

```css
[hidden] { display: none !important; }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test` e `npm run check`
Expected: PASS.

- [ ] **Step 7: Visual check**

Com o servidor rodando (`npm start`), recarregar http://localhost:3000, trocar a arquitetura e conferir: campos de voz e modelo trocam, a cabine mostra "Português brasileiro, Transcribe + Bedrock + Polly". Sem navegador conectado, usar o Edge headless:

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --window-size=1440,900 --virtual-time-budget=4000 --screenshot="$PWD/ui.png" http://localhost:3000/
```

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.js public/styles.css tests/ui.test.js
git commit -m "feat: seletor de arquitetura e campos da cascata na interface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Probe de conta, documentação e validação real

**Files:**
- Create: `scripts/probe-cascade.js`
- Modify: `package.json` (script `probe:cascade`)
- Modify: `README.md`
- Modify: `.env` local (não versionado): adicionar `CASCADE_LLM_MODEL_ID`

**Interfaces:**
- Consumes: `getAwsSettings()` de `src/aws-settings.js`; `CASCADE_LLM_MODEL_ID`.
- Produces: `npm run probe:cascade`, que testa Polly streaming, Transcribe pt-BR e ConverseStream com o perfil do `.env` e imprime as latências.

- [ ] **Step 1: Write `scripts/probe-cascade.js`**

```js
import { PollyClient, SynthesizeSpeechCommand, StartSpeechSynthesisStreamCommand } from '@aws-sdk/client-polly';
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from '@aws-sdk/client-transcribe-streaming';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { getAwsSettings } from '../src/aws-settings.js';

// Confere permissões e latências da cascata com o perfil do .env, sem abrir a interface.
const { awsProfile, region } = getAwsSettings();
const options = { region, credentials: fromIni({ profile: awsProfile }), maxAttempts: 1 };
const modelId = process.env.CASCADE_LLM_MODEL_ID;
if (!modelId) { console.error('Defina CASCADE_LLM_MODEL_ID no .env.'); process.exit(1); }
const sentence = 'Quero saber o prazo de entrega do meu pedido.';
const polly = new PollyClient(options); const transcribe = new TranscribeStreamingClient(options); const bedrock = new BedrockRuntimeClient(options);
async function step(name, action) {
  try { console.log(`ok   ${name}:`, await action(performance.now())); }
  catch (error) { console.log(`ERRO ${name}: ${error.name} ${error.message}`); process.exitCode = 1; }
}
let speech = Buffer.alloc(0);
await step('Polly streaming (Camila, PCM 16 kHz)', async started => {
  const ActionStream = (async function* () { yield { TextEvent: { Text: sentence, FlushStreamConfiguration: { Force: true } } }; yield { CloseStreamEvent: {} }; })();
  const response = await polly.send(new StartSpeechSynthesisStreamCommand({ Engine: 'generative', VoiceId: 'Camila', OutputFormat: 'pcm', SampleRate: '16000', ActionStream }));
  let first = null; const chunks = [];
  for await (const event of response.EventStream) if (event.AudioEvent?.AudioChunk) { first ??= performance.now() - started; chunks.push(event.AudioEvent.AudioChunk); }
  speech = Buffer.concat(chunks);
  return { primeiroAudioMs: Math.round(first), segundosDeAudio: Number((speech.length / 32000).toFixed(2)) };
});
await step('Transcribe Streaming pt-BR', async () => {
  if (!speech.length) speech = Buffer.from(await (await polly.send(new SynthesizeSpeechCommand({ Engine: 'generative', VoiceId: 'Camila', OutputFormat: 'pcm', SampleRate: '16000', Text: sentence }))).AudioStream.transformToByteArray());
  const audio = Buffer.concat([speech, Buffer.alloc(64000)]);
  const started = performance.now(); const speechEndMs = speech.length / 32;
  const AudioStream = (async function* () {
    for (let i = 0; i < audio.length; i += 1024) { yield { AudioEvent: { AudioChunk: audio.subarray(i, i + 1024) } }; await new Promise(resolve => setTimeout(resolve, 32)); }
  })();
  const response = await transcribe.send(new StartStreamTranscriptionCommand({ LanguageCode: 'pt-BR', MediaEncoding: 'pcm', MediaSampleRateHertz: 16000, AudioStream }));
  let lastPartialMs = null; let final = null;
  for await (const event of response.TranscriptResultStream) {
    for (const result of event.TranscriptEvent?.Transcript?.Results || []) {
      const afterSpeech = Math.round(performance.now() - started - speechEndMs);
      if (result.IsPartial) lastPartialMs = afterSpeech; else final ??= { texto: result.Alternatives[0].Transcript, msAposFimDaFala: afterSpeech };
    }
  }
  return { ultimoParcialMsAposFimDaFala: lastPartialMs, final };
});
await step(`Bedrock ConverseStream (${modelId})`, async started => {
  const response = await bedrock.send(new ConverseStreamCommand({ modelId, system: [{ text: 'Responda em uma frase curta em português.' }], messages: [{ role: 'user', content: [{ text: sentence }] }], inferenceConfig: { maxTokens: 200, temperature: 0.7 } }));
  let first = null; let text = '';
  for await (const event of response.stream) if (event.contentBlockDelta?.delta?.text) { first ??= performance.now() - started; text += event.contentBlockDelta.delta.text; }
  return { primeiroTokenMs: Math.round(first), texto: text };
});
polly.destroy(); transcribe.destroy(); bedrock.destroy();
```

Em `package.json`, dentro de `scripts`:

```json
    "probe:cascade": "node --env-file-if-exists=.env scripts/probe-cascade.js",
```

- [ ] **Step 2: Configure `.env` and run the probe**

Adicionar ao `.env` local (não versionado):

```dotenv
CASCADE_LLM_MODEL_ID=us.amazon.nova-2-lite-v1:0
```

Run: `npm run probe:cascade`
Expected: três linhas `ok`. Primeiro áudio do Polly abaixo de ~1 s, transcrição correta, primeiro token abaixo de ~1,2 s. Anotar `ultimoParcialMsAposFimDaFala`: se passar de 250 ms com frequência, aumentar `settleMs` do `TurnDetector`.

- [ ] **Step 3: Update `README.md`**

Depois da seção "### Nova 2 versus Nova 2.5", adicionar:

````markdown
### Transcribe + Bedrock + Polly

Segunda arquitetura da comparação. Escolha **Arquitetura: Transcribe + Bedrock + Polly** na tela. A fala vai ao Transcribe Streaming, o servidor decide o fim do turno pelo silêncio do microfone (Rápida 400 ms, Equilibrada 700 ms, Paciente 1100 ms), o texto vai ao Bedrock (`ConverseStream`) e a resposta é falada pelo Polly generativo em PCM 16 kHz, frase a frase. Detalhes e medições em `docs/polly-cascade-design.md`.

Defina o modelo de texto padrão no `.env`:

```dotenv
CASCADE_LLM_MODEL_ID=us.amazon.nova-2-lite-v1:0
```

Confira permissões e latências da conta sem abrir a interface:

```powershell
npm run probe:cascade
```

Permissões usadas: `transcribe:StartStreamTranscription`, síntese do Polly (`polly:SynthesizeSpeech` e o streaming bidirecional) e `bedrock:InvokeModelWithResponseStream` no inference profile escolhido e nos modelos de base dele. A ação IAM exata do streaming do Polly ainda não foi confirmada com um perfil restrito.

A única voz generativa em português brasileiro é **Camila**. Use fones: sem eles, a voz do Polly captada pelo microfone pode interromper a própria resposta.
````

Na seção "## Arquivos e dados", adicionar:

```markdown
- `src/cascade/`: arquitetura em cascata (`turn.js` fim de turno, frases e PCM; `aws.js` adaptadores de Transcribe, Bedrock e Polly; `session.js` orquestração).
- `scripts/probe-cascade.js`: verificação de permissões e latências da cascata na conta.
```

E em "### Latência", adicionar ao fim da lista:

```markdown
- Na arquitetura em cascata, "Latência do modelo" vai do fim do turno decidido pelo servidor até o primeiro áudio do Polly. A cabine também mostra, por turno, o tempo até o primeiro texto do Bedrock e o tempo entre a primeira frase e a primeira voz.
```

- [ ] **Step 4: Run all checks**

Run: `npm test` e `npm run check`
Expected: PASS.

- [ ] **Step 5: Real conversation (manual, with the user)**

Com fones, `npm start`, arquitetura "Transcribe + Bedrock + Polly", modelo `us.amazon.nova-2-lite-v1:0`:

1. 5 a 10 turnos em pt-BR: a voz da Camila responde e a transcrição aparece nos dois lados.
2. Latências na cabine: percebida maior que a do modelo; etapas preenchidas.
3. Falar por cima da resposta com "Permitir interromper" ligado: a voz para em menos de 1 s.
4. Desligar a interrupção, iniciar outra conversa e falar por cima: a resposta continua.
5. Encerrar no meio de uma resposta: a voz para e o microfone é liberado, sem erro.
6. Trocar para Nova Sonic e repetir 1 e 2 para comparar.

Anotar p50/p95 das duas arquiteturas e registrar no ledger do plano.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe-cascade.js package.json README.md
git commit -m "docs: probe da cascata e instruções de uso do Polly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Ledger

- 2026-10-06: plano escrito a partir de probes reais na conta (vozes, streaming do Polly, Transcribe pt-BR, primeiro token de três modelos). Execução pendente.
- 2026-10-06: executado com subagentes (Tasks 1-7, uma rodada de correção nas Tasks 4 e 6, revisão final e uma onda de correção). 40 testes passando. Probe real: Polly 1º áudio 814 ms; Transcribe último parcial 1158 ms e final 1488 ms após a fala; Nova 2 Lite 1º token 887 ms. Pendente: conversa real com microfone (Task 7 Step 5) e calibração de settleMs/ENDPOINT_MS.
