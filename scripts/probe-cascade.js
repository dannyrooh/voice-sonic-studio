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
try {
  let speech = Buffer.alloc(0);
  await step('Polly streaming (Camila, PCM 16 kHz)', async started => {
    const ActionStream = (async function* () { yield { TextEvent: { Text: sentence, FlushStreamConfiguration: { Force: true } } }; yield { CloseStreamEvent: {} }; })();
    const response = await polly.send(new StartSpeechSynthesisStreamCommand({ Engine: 'generative', VoiceId: 'Camila', OutputFormat: 'pcm', SampleRate: '16000', ActionStream }));
    let first = null; const chunks = [];
    for await (const event of response.EventStream) if (event.AudioEvent?.AudioChunk) { first ??= performance.now() - started; chunks.push(event.AudioEvent.AudioChunk); }
    speech = Buffer.concat(chunks);
    if (first === null) throw new Error('nenhum chunk de áudio recebido');
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
    if (first === null) throw new Error('nenhum token recebido');
    return { primeiroTokenMs: Math.round(first), texto: text };
  });
} finally { polly.destroy(); transcribe.destroy(); bedrock.destroy(); }
