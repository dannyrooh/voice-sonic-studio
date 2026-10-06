import { AudioBridge } from './audio.js';
import { LatencyLog, describeLatency } from './metrics.js';

const $ = id => document.getElementById(id);
const form = $('config-form');
let initial; let avatar = null; let currentId = null; let dirty = false;
let editRevision = 0; let contextRevision = 0;
let audio = null; let socket = null; let active = false; let connecting = false; let attempt = 0; let connectTimer;
const transcripts = new Map();
let latency = new LatencyLog();

function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Falha HTTP ${response.status}`);
  return data;
}
function readConfig() {
  return {
    schemaVersion: 1, name: $('config-name').value,
    pipeline: $('pipeline').value,
    character: { name: $('character-name').value, avatar },
    connection: { modelId: $('model-id').value },
    cascade: { llmModelId: $('llm-model-id').value, pollyVoiceId: $('polly-voice-id').value },
    conversation: {
      voiceId: $('voice-id').value, language: $('language').value, systemPrompt: $('system-prompt').value,
      endpointingSensitivity: $('sensitivity').value, allowInterruption: $('interruption').checked,
      temperature: Number($('temperature').value), topP: Number($('top-p').value), maxTokens: Number($('max-tokens').value),
    },
  };
}
function renderAvatar(container, small = false) {
  container.replaceChildren();
  if (avatar) { const image = document.createElement('img'); image.src = avatar.dataUrl; image.alt = `Personagem ${$('character-name').value}`; container.append(image); }
  else { const span = document.createElement('span'); span.textContent = ($('character-name').value || 'A').slice(0, 1); container.append(span); }
}
function showPipeline() { for (const element of document.querySelectorAll('[data-pipeline]')) element.hidden = element.dataset.pipeline !== $('pipeline').value; }
function updatePreview() {
  showPipeline();
  const c = readConfig();
  if (!active && !connecting) {
    $('preview-name').textContent = c.character.name || 'Personagem';
    $('preview-language').textContent = `${$('language').selectedOptions[0].textContent}, ${$('pipeline').selectedOptions[0].textContent}`;
    renderAvatar($('conversation-avatar'), true);
  }
  renderAvatar($('avatar-preview'));
  const preview = structuredClone(c);
  if (preview.character.avatar) preview.character.avatar.dataUrl = '[imagem embutida no JSON exportado]';
  $('json-preview').textContent = JSON.stringify(preview, null, 2);
  $('remove-image').disabled = !avatar;
}
function markDirty() { editRevision++; dirty = true; $('save-state').textContent = 'Alterações não salvas'; $('save-state').classList.replace('saved', 'dirty') || $('save-state').classList.add('dirty'); updatePreview(); }
function applyConfig(c, id = null) {
  editRevision++; contextRevision++;
  currentId = id; avatar = c.character.avatar;
  $('config-name').value = c.name; $('character-name').value = c.character.name;
  $('model-id').value = c.connection.modelId;
  $('pipeline').value = c.pipeline; $('llm-model-id').value = c.cascade.llmModelId; $('polly-voice-id').value = c.cascade.pollyVoiceId;
  $('voice-id').value = c.conversation.voiceId; $('language').value = c.conversation.language;
  $('system-prompt').value = c.conversation.systemPrompt; $('sensitivity').value = c.conversation.endpointingSensitivity;
  $('interruption').checked = c.conversation.allowInterruption;
  $('temperature').value = c.conversation.temperature; $('top-p').value = c.conversation.topP; $('max-tokens').value = c.conversation.maxTokens;
  $('avatar').value = ''; dirty = false;
  $('save-state').textContent = id ? 'Configuração salva' : 'Nova configuração'; $('save-state').classList.remove('dirty'); $('save-state').classList.toggle('saved', Boolean(id));
  $('loaded-info').textContent = id ? `Editando: ${c.name}` : 'Nova configuração';
  updatePreview();
}
async function refreshSaved(selected = currentId) {
  const configs = await api('/api/configs'); $('saved-configs').replaceChildren(new Option('Selecione uma configuração', ''));
  for (const c of configs) $('saved-configs').add(new Option(c.name, c.id));
  $('saved-configs').value = selected || ''; $('load-config').disabled = !configs.length;
}
function download(config) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'sonic-config.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function save(asNew = false) {
  if (!form.reportValidity()) return;
  const buttons = [$('save-config'), $('save-copy')]; buttons.forEach(b => b.disabled = true);
  const editAtSave = editRevision; const contextAtSave = contextRevision;
  try {
    const id = asNew ? null : currentId;
    const c = await api(id ? `/api/configs/${id}` : '/api/configs', { method: id ? 'PUT' : 'POST', body: JSON.stringify(readConfig()) });
    if (editRevision === editAtSave) {
      applyConfig(c, c.id); await refreshSaved(); notice('Configuração salva em JSON no disco.');
    } else {
      if (contextRevision === contextAtSave) { currentId = c.id; $('loaded-info').textContent = `Editando: ${$('config-name').value}`; }
      await refreshSaved(); notice('Versão enviada salva. As alterações posteriores foram preservadas e ainda precisam ser salvas.');
    }
  } catch (error) { notice(error.message, true); } finally { buttons.forEach(b => b.disabled = false); }
}
form.addEventListener('input', event => { if (!['saved-configs', 'avatar', 'import-json'].includes(event.target.id)) markDirty(); });
form.onsubmit = event => { event.preventDefault(); save(); };
$('save-copy').onclick = () => save(true);
$('remove-image').onclick = () => { avatar = null; $('avatar').value = ''; markDirty(); };
$('avatar').onchange = async () => {
  const file = $('avatar').files[0]; if (!file) return;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Escolha PNG, JPG ou WebP de até 5 MB.');
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Não foi possível ler a imagem.')); reader.readAsDataURL(file); });
    const img = new Image(); img.src = dataUrl; await img.decode();
    const candidate = { fileName: file.name, mimeType: file.type, dataUrl };
    await api('/api/validate', { method: 'POST', body: JSON.stringify({ ...readConfig(), character: { name: $('character-name').value, avatar: candidate } }) });
    avatar = candidate; markDirty(); notice('Imagem adicionada ao personagem.');
  } catch (error) { notice(error.message, true); $('avatar').value = ''; }
};
$('load-config').onclick = async () => {
  const id = $('saved-configs').value; if (!id) return;
  if (dirty && !confirm('Descartar as alterações não salvas e carregar esta configuração?')) return;
  try { applyConfig(await api(`/api/configs/${id}`), id); notice('Configuração carregada.'); }
  catch (error) { notice(error.message, true); }
};
$('new-config').onclick = () => {
  if (dirty && !confirm('Descartar as alterações não salvas e criar uma configuração?')) return;
  applyConfig(structuredClone(initial)); $('saved-configs').value = ''; notice('Nova configuração pronta para editar.');
};
$('import-json').onchange = async () => {
  const file = $('import-json').files[0]; if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('O JSON deve ter até 8 MB.');
    const c = await api('/api/validate', { method: 'POST', body: JSON.stringify(JSON.parse(await file.text())) });
    if (dirty && !confirm('Descartar as alterações não salvas e importar esta configuração?')) return;
    if (c.character.avatar) { const image = new Image(); image.src = c.character.avatar.dataUrl; await image.decode(); }
    applyConfig(c); markDirty(); notice('JSON importado. Salve para guardar na biblioteca.');
  } catch (error) { notice(error instanceof SyntaxError ? 'O arquivo não contém JSON válido.' : error.message, true); }
  finally { $('import-json').value = ''; }
};
$('export-json').onclick = async () => {
  if (!form.reportValidity()) return;
  try { const c = await api('/api/validate', { method: 'POST', body: JSON.stringify(readConfig()) }); download(c); notice('JSON exportado com imagem e parâmetros.'); }
  catch (error) { notice(error.message, true); }
};
$('query-models').onclick = async () => {
  if (!form.reportValidity()) return;
  const button = $('query-models'); button.disabled = true; $('model-status').textContent = 'Consultando Bedrock…';
  try {
    const result = await api('/api/models', { method: 'POST', body: JSON.stringify(readConfig()) });
    $('model-options').replaceChildren();
    for (const m of result.models) $('model-options').append(new Option(m.name, m.id));
    $('model-status').textContent = result.models.length ? `${result.models.length} modelos Sonic encontrados. Selecione o identificador acima; a listagem não comprova permissão de invocação.` : 'Nenhum modelo Sonic encontrado nesta região.';
  } catch (error) { $('model-status').textContent = error.message; notice(error.message, true); }
  finally { button.disabled = false; }
};

function conversationState(text, connected = false) { $('voice-state').textContent = text; $('connection-status').textContent = connected ? 'Conversa conectada' : 'Conversa desconectada'; $('connection-status').classList.toggle('connected', connected);
  document.querySelector('.booth').dataset.state = !connected ? 'idle' : text === 'Falando' ? 'speaking' : 'live';
}
function resetConversation() {
  clearTimeout(connectTimer); audio?.close(); audio = null; socket = null; active = false; connecting = false;
  $('start-conversation').disabled = false; $('stop-conversation').disabled = true; conversationState('Pronto para começar');
  updatePreview();
}
function stopConversation() {
  attempt++; audio?.close();
  if (socket) { const ws = socket; if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' })); ws.close(); }
  resetConversation();
}
function recordLatency(source, ms) {
  latency.add(source, ms); renderLatency();
}
function renderLatency() {
  for (const source of ['perceived', 'model']) {
    const { value, detail } = describeLatency(latency.summary(source));
    $(`latency-${source}`).textContent = value; $(`latency-${source}-detail`).textContent = detail;
  }
}
function showTranscript(message) {
  let record = transcripts.get(message.id);
  if (!record) {
    $('transcripts').querySelector('.empty-message')?.remove();
    const box = document.createElement('div'); box.className = `message ${message.role === 'ASSISTANT' ? 'assistant' : 'user'}`;
    const label = document.createElement('strong'); label.textContent = message.role === 'USER' ? 'VOCÊ' : $('preview-name').textContent.toUpperCase();
    const text = document.createElement('p'); box.append(label, text); $('transcripts').append(box);
    record = { text, value: '' }; transcripts.set(message.id, record);
    if (transcripts.size > 100) { const oldest = transcripts.keys().next().value; transcripts.get(oldest).text.parentElement.remove(); transcripts.delete(oldest); }
  }
  const box = $('transcripts'); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  record.value += message.text; record.text.textContent = record.value;
  if (atBottom) box.scrollTop = box.scrollHeight;
}
$('start-conversation').onclick = async () => {
  if (!form.reportValidity() || active || connecting) return;
  const config = readConfig();
  const missingModel = config.pipeline === 'polly' ? !config.cascade.llmModelId.trim() && 'llm-model-id' : !config.connection.modelId.trim() && 'model-id';
  if (missingModel) { notice(config.pipeline === 'polly' ? 'Informe o modelo de texto do Bedrock antes de iniciar.' : 'Informe o identificador do modelo Sonic antes de iniciar.', true); $(missingModel).focus(); return; }
  connecting = true; const token = ++attempt;
  latency = new LatencyLog(); renderLatency(); $('stages').textContent = '';
  $('start-conversation').disabled = true; $('stop-conversation').disabled = false; conversationState('Solicitando microfone…');
  const bridge = new AudioBridge(bytes => {
    if (active && socket?.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > 1024 * 1024) { notice('Conexão lenta: fila de áudio excedida.', true); stopConversation(); return; }
      socket.send(bytes);
    }
  }, state => conversationState(state, true), ms => { if (token === attempt) recordLatency('perceived', ms); }); audio = bridge;
  try {
    await bridge.prepare(); if (token !== attempt) return;
    const validated = await api('/api/validate', { method: 'POST', body: JSON.stringify(config) });
    if (token !== attempt) return;
    conversationState('Conectando ao Sonic…');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); socket = ws;
    connectTimer = setTimeout(() => { if (token === attempt && !active) { notice('Tempo esgotado ao conectar. Verifique perfil AWS, região e modelo.', true); stopConversation(); } }, 25000);
    ws.onopen = () => { if (token !== attempt) { ws.close(); return; } ws.send(JSON.stringify({ type: 'start', config: validated })); };
    ws.onmessage = event => {
      if (token !== attempt) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ready') { clearTimeout(connectTimer); active = true; connecting = false; bridge.begin(config.conversation.allowInterruption); notice('Conversa iniciada. Fale com o personagem.'); }
        else if (message.type === 'audio') bridge.play(message.audio, message.sampleRate);
        else if (message.type === 'transcript') showTranscript(message);
        else if (message.type === 'interrupted') bridge.interrupt();
        else if (message.type === 'latency') {
          recordLatency(message.source, message.ms);
          if (message.stages) $('stages').textContent = `Último turno: primeiro texto em ${message.stages.llm} ms, voz ${message.stages.tts} ms depois da primeira frase.`;
        }
        else if (message.type === 'usage') $('usage').textContent = `Tokens: ${message.inputTokens ?? '—'} de entrada, ${message.outputTokens ?? '—'} de saída${message.ttsCharacters === undefined ? '' : `, ${message.ttsCharacters} caracteres de voz`}`;
        else if (message.type === 'error') { notice(message.message, true); stopConversation(); }
        else if (message.type === 'ended') { notice(message.message || 'Conversa encerrada.'); stopConversation(); }
      } catch (error) { notice(error.message, true); stopConversation(); }
    };
    ws.onerror = () => { if (token === attempt) notice('Falha na conexão com o servidor local.', true); };
    ws.onclose = () => { if (token === attempt) { attempt++; resetConversation(); } };
  } catch (error) {
    if (token !== attempt) return;
    notice(error.name === 'NotAllowedError' ? 'Permita o acesso ao microfone no navegador para conversar.' : error.message, true); stopConversation();
  }
};
$('stop-conversation').onclick = () => { stopConversation(); notice('Conversa encerrada e microfone liberado.'); };
$('clear-transcript').onclick = () => { transcripts.clear(); const empty = document.createElement('p'); empty.className = 'empty-message'; empty.textContent = 'Transcrição limpa. As próximas falas aparecem aqui.'; $('transcripts').replaceChildren(empty); $('usage').textContent = ''; $('stages').textContent = ''; latency = new LatencyLog(); renderLatency(); };
window.addEventListener('beforeunload', event => { audio?.close(); socket?.close(); if (dirty) { event.preventDefault(); event.returnValue = ''; } });
async function initialize() {
  try {
    const bootstrap = await api('/api/bootstrap'); initial = bootstrap.defaults;
    $('profile-badge').textContent = `${bootstrap.aws.awsProfile} / ${bootstrap.aws.region}`;
    $('aws-info').textContent = `Perfil ${bootstrap.aws.awsProfile} na região ${bootstrap.aws.region}, lidos do .env da raiz. Reinicie o servidor após alterar.`;
    bootstrap.voices.forEach(v => $('voice-options').append(new Option(v.label, v.id)));
    bootstrap.pollyVoices.forEach(v => $('polly-voice-options').append(new Option(v.label, v.id)));
    applyConfig(initial); await refreshSaved();
  } catch (error) { notice(`Não foi possível iniciar a tela: ${error.message}`, true); $('start-conversation').disabled = true; }
}
initialize();
