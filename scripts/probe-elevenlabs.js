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
