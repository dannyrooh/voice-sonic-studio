import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { createApplication } from '../src/app.js';

async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('A interface não atingiu o estado esperado.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('UI initializes, saves, reloads and exports the edited configuration through real HTTP', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sonic-ui-'));
  const { server } = createApplication({ dataDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: base });
  const originals = new Map();
  const bind = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const nativeFetch = globalThis.fetch;
  let delaySave = false; let releaseSave; let saveResponsePending = false;
  bind('document', dom.window.document); bind('window', dom.window); bind('Option', dom.window.Option); bind('location', dom.window.location); bind('confirm', () => true);
  bind('fetch', async (path, options) => {
    const response = await nativeFetch(new URL(path, base), options);
    if (delaySave && options?.method === 'PUT') {
      saveResponsePending = true;
      await new Promise(resolve => { releaseSave = resolve; });
    }
    return response;
  });
  const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
  let exported;
  URL.createObjectURL = blob => { exported = blob; return 'blob:test'; }; URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  t.after(async () => {
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    dom.window.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await import('../public/app.js');
  const $ = id => dom.window.document.getElementById(id);
  try {
    await until(() => $('system-prompt').value.includes('cordial') && $('saved-configs').options[0]?.textContent === 'Selecione uma configuração');
  } catch (error) { throw new Error(`${error.message} Estado: ${$('notice').textContent}; prompt: ${$('system-prompt').value}; opção: ${$('saved-configs').options[0]?.textContent}`); }
  assert.match($('profile-badge').textContent, /marksell/);
  assert.equal($('aws-profile'), null);
  assert.equal($('region'), null);
  $('character-name').value = 'Beatriz'; $('character-name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  $('config-name').value = 'Comercial Beatriz';
  $('temperature').value = '0.25';
  $('config-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('notice').textContent === 'Configuração salva em JSON no disco.');
  assert.equal($('saved-configs').options.length, 2);
  assert.equal($('preview-name').textContent, 'Beatriz');
  $('character-name').value = 'Alterado'; $('character-name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  $('load-config').click();
  await until(() => $('notice').textContent === 'Configuração carregada.');
  assert.equal($('character-name').value, 'Beatriz');
  assert.equal($('temperature').value, '0.25');
  $('export-json').click(); await until(() => !!exported);
  const config = JSON.parse(await exported.text());
  assert.equal(config.character.name, 'Beatriz');
  assert.equal(Object.hasOwn(config.connection, 'awsProfile'), false);
  assert.equal(Object.hasOwn(config.connection, 'region'), false);
  assert.equal(config.conversation.temperature, 0.25);
  assert.equal(config.character.avatar, null);
  delaySave = true;
  $('config-name').value = 'Versão enviada';
  $('config-name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  $('config-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => saveResponsePending);
  $('config-name').value = 'Edição durante salvamento';
  $('config-name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  releaseSave();
  await until(() => !$('save-config').disabled);
  assert.equal($('config-name').value, 'Edição durante salvamento');
  assert.equal($('save-state').textContent, 'Alterações não salvas');
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
  $('voice-id').value = '';
  assert.equal($('config-form').checkValidity(), true);
  $('pipeline').value = 'sonic'; $('pipeline').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal($('config-form').checkValidity(), false);
  assert.equal($('polly-voice-id').disabled, true);
  $('voice-id').value = 'carolina';
});
