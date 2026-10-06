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
