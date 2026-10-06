import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApplication, createSession } from '../src/app.js';
import { defaults, validateConfig } from '../src/config.js';
import { SonicSession } from '../src/sonic.js';
import { CascadeSession } from '../src/cascade/session.js';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sonic-http-'));
  const { server, wss } = createApplication({ dataDir, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return url;
}
test('HTTP persists and retrieves configurations, rejects bad JSON and missing configs', async t => {
  const url = await fixture(t);
  const response = await fetch(`${url}/api/configs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(defaults()) });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal((await (await fetch(`${url}/api/configs/${saved.id}`)).json()).name, 'Aurora · Atendimento comercial');
  const updated = await fetch(`${url}/api/configs/${saved.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...saved, name: 'Atualizada' }) });
  assert.equal(updated.status, 200);
  assert.equal((await (await fetch(`${url}/api/configs`)).json())[0].name, 'Atualizada');
  const bad = await fetch(`${url}/api/configs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${url}/api/configs/00000000-0000-4000-8000-000000000000`)).status, 404);
});
test('blocks foreign origins and serves the application with CSP', async t => {
  const url = await fixture(t);
  const foreign = await fetch(`${url}/api/configs`, { headers: { Origin: 'https://example.com' } });
  assert.equal(foreign.status, 403);
  const response = await fetch(`${url}/`);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await response.text(), /Sonic Studio/);
});
test('model lookup uses server AWS settings instead of legacy JSON overrides', async t => {
  let used;
  const awsSettings = { awsProfile: 'env-profile', region: 'us-west-2' };
  const url = await fixture(t, { awsSettings, modelsProvider: async settings => { used = settings; return []; } });
  const config = defaults(); config.connection.awsProfile = 'ignored'; config.connection.region = 'eu-west-1';
  const response = await fetch(`${url}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(response.status, 200);
  assert.deepEqual(used, awsSettings);
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  assert.deepEqual(bootstrap.aws, awsSettings);
  assert.equal(Object.hasOwn(bootstrap.defaults.connection, 'region'), false);
});
test('WebSocket uses current config, transfers PCM and aborts resources on disconnect', async t => {
  let actual; let actualAws; let received; let aborted = false;
  const url = await fixture(t, { awsSettings: { awsProfile: 'server-profile', region: 'us-west-2' }, sessionFactory: (config, send, aws) => {
    actual = config;
    actualAws = aws;
    return { start: async () => { send({ type: 'ready' }); await new Promise(() => {}); }, audio: bytes => { received = bytes; }, abort: () => { aborted = true; }, stop: () => {} };
  } });
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { origin: url });
  await once(ws, 'open');
  const ready = once(ws, 'message');
  const config = defaults(); config.connection.modelId = 'amazon.nova-2-sonic-v1:0';
  config.connection.awsProfile = 'ignored-profile'; config.connection.region = 'eu-west-1';
  ws.send(JSON.stringify({ type: 'start', config }));
  assert.equal(JSON.parse((await ready)[0]).type, 'ready');
  assert.deepEqual(actualAws, { awsProfile: 'server-profile', region: 'us-west-2' });
  assert.equal(Object.hasOwn(actual.connection, 'awsProfile'), false);
  ws.send(Buffer.from([0, 1, 2, 3]));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(received, Buffer.from([0, 1, 2, 3]));
  ws.close(); await once(ws, 'close');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(aborted, true);
});
test('invalid websocket configuration returns error before creating AWS session', async t => {
  let created = false;
  const url = await fixture(t, { sessionFactory: () => { created = true; } });
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { origin: url });
  await once(ws, 'open'); const message = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'start', config: defaults() }));
  assert.equal(JSON.parse((await message)[0]).type, 'error');
  assert.equal(created, false);
  ws.close();
});
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
