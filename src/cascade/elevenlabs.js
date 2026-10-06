import WebSocket from 'ws';
import { EventQueue } from '../sonic.js';

export const ELEVEN_LANGUAGES = { 'pt-BR': 'pt', 'en-US': 'en', es: 'es', fr: 'fr', de: 'de', it: 'it', hi: 'hi' };

export function elevenLabsSettings(env = process.env) {
  return { apiKey: env.ELEVENLABS_API_KEY?.trim() || '', modelId: env.ELEVENLABS_MODEL_ID?.trim() || '' };
}

// Mesmo contrato do speak da AWS: frases entram, PCM 16 kHz sai, e no fim a contagem de caracteres.
export function createElevenLabsSpeaker({ apiKey, modelId, language }, { WebSocketImpl = WebSocket } = {}) {
  return async function* speakWithElevenLabs(texts, voiceId, signal) {
    const query = new URLSearchParams({ model_id: modelId, output_format: 'pcm_16000', inactivity_timeout: '60' });
    if (modelId.includes('v2_5')) query.set('language_code', ELEVEN_LANGUAGES[language]);
    const socket = new WebSocketImpl(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${query}`, { headers: { 'xi-api-key': apiKey } });
    const events = new EventQueue(4096);
    socket.on('message', data => events.push({ data }));
    socket.on('error', error => events.push({ error }));
    socket.on('close', (code, reason) => { events.push({ close: { code, reason: String(reason || '') } }); events.close(); });
    const abort = () => socket.terminate();
    signal?.addEventListener('abort', abort, { once: true });
    let characters = 0;
    try {
      try { await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', resolve); }); }
      catch (error) {
        if (signal?.aborted) return;
        throw new Error(`ElevenLabs: ${error.message}. Verifique ELEVENLABS_API_KEY, a voz escolhida e ELEVENLABS_MODEL_ID.`);
      }
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
