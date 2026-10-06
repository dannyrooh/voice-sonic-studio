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
