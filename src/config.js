export class ValidationError extends Error {}
export const VOICES = [
  { id: 'carolina', label: 'Carolina · Português brasileiro' },
  { id: 'leo', label: 'Leo · Português' },
  { id: 'tiffany', label: 'Tiffany · Poliglota' },
  { id: 'matthew', label: 'Matthew · Poliglota' },
];
export const PIPELINES = ['sonic', 'polly'];
export const POLLY_VOICES = [{ id: 'Camila', label: 'Camila · Português brasileiro (generativa)' }];
export function defaults() {
  return {
    schemaVersion: 1,
    name: 'Aurora · Atendimento comercial',
    pipeline: 'sonic',
    character: { name: 'Aurora', avatar: null },
    connection: {
      modelId: process.env.SONIC_MODEL_ID || '',
    },
    cascade: { llmModelId: process.env.CASCADE_LLM_MODEL_ID || '', pollyVoiceId: 'Camila' },
    conversation: {
      voiceId: 'carolina', language: 'pt-BR',
      systemPrompt: 'Você é Aurora, uma assistente comercial cordial. Converse com respostas curtas e claras. Faça uma pergunta de cada vez e confirme valores e nomes quando necessário.',
      endpointingSensitivity: 'MEDIUM', allowInterruption: true,
      temperature: 0.7, topP: 0.9, maxTokens: 1024,
    },
  };
}

function fail(message) { throw new ValidationError(message); }
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} inválida.`);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`Campo desconhecido em ${label}. Credenciais não devem ser salvas no JSON.`);
}
function string(value, label, max, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) fail(`${label} inválido (máximo ${max} caracteres).`);
  return value.trim();
}
function number(value, min, max, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${label} deve estar entre ${min} e ${max}.`);
  return value;
}
export function validateAvatar(avatar) {
  if (avatar === null) return null;
  object(avatar, ['fileName', 'mimeType', 'dataUrl'], 'imagem');
  const fileName = string(avatar.fileName, 'Nome da imagem', 255);
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(avatar.mimeType) || typeof avatar.dataUrl !== 'string') fail('Formato de imagem inválido.');
  const prefix = `data:${avatar.mimeType};base64,`;
  if (!avatar.dataUrl.startsWith(prefix)) fail('Imagem inválida.');
  const encoded = avatar.dataUrl.slice(prefix.length);
  if (encoded.length > Math.ceil(5 * 1024 * 1024 / 3) * 4) fail('A imagem deve ter até 5 MB.');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('Imagem base64 inválida.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 5 * 1024 * 1024) fail('A imagem deve ter até 5 MB.');
  const valid = avatar.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : avatar.mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) fail('O conteúdo da imagem não corresponde ao formato.');
  return { fileName, mimeType: avatar.mimeType, dataUrl: avatar.dataUrl };
}

export function validateConfig(input, { requireModel = false } = {}) {
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
  // Perfil e região de arquivos antigos são aceitos apenas para leitura e descartados.
  const c = input.conversation;
  if (!['pt-BR', 'en-US', 'es', 'fr', 'de', 'it', 'hi'].includes(c.language)) fail('Idioma inválido.');
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(c.endpointingSensitivity)) fail('Espera entre turnos inválida.');
  if (typeof c.allowInterruption !== 'boolean') fail('Permitir interrupção deve ser booleano.');
  return {
    schemaVersion: 1, name: string(input.name, 'Nome da configuração', 100), pipeline,
    character: { name: string(input.character.name, 'Nome do personagem', 80), avatar: validateAvatar(input.character.avatar) },
    connection,
    cascade: {
      llmModelId: string(cascade.llmModelId, 'Modelo de texto', 200, !(requireModel && pipeline === 'polly')),
      pollyVoiceId: string(cascade.pollyVoiceId, 'Voz do Polly', 40),
    },
    conversation: {
      voiceId: string(c.voiceId, 'Identificador da voz', 80), language: c.language,
      systemPrompt: string(c.systemPrompt, 'Instruções', 12000),
      endpointingSensitivity: c.endpointingSensitivity, allowInterruption: c.allowInterruption,
      temperature: number(c.temperature, 0, 1, 'Temperatura'),
      topP: number(c.topP, 0.01, 1, 'Top P'),
      maxTokens: number(c.maxTokens, 1, 4096, 'Limite de tokens', true),
    },
  };
}
