import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, validateConfig } from '../src/config.js';
import { ConfigStore } from '../src/store.js';

test('persists image and voice settings across store restart and updates same ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sonic-'));
  try {
    const c = defaults();
    c.character.avatar = { fileName: 'avatar.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    c.conversation.temperature = 0.3;
    const saved = await new ConfigStore(dir).save(c);
    const restarted = new ConfigStore(dir);
    assert.equal((await restarted.get(saved.id)).character.avatar.dataUrl, c.character.avatar.dataUrl);
    assert.equal((await restarted.get(saved.id)).conversation.temperature, 0.3);
    const updated = await restarted.save({ ...saved, name: 'Outra configuração' }, saved.id);
    assert.equal(updated.id, saved.id);
    assert.equal((await restarted.list()).length, 1);
    assert.equal(JSON.parse(await readFile(join(dir, `${saved.id}.json`), 'utf8')).name, 'Outra configuração');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects traversal IDs without writing outside storage', async () => {
  const store = new ConfigStore(join(tmpdir(), 'sonic-unused'));
  await assert.rejects(store.get('../secrets'), /identificador/i);
  await assert.rejects(store.save(defaults(), '../secrets'), /identificador/i);
});

test('rejects malformed fields, unsupported schema, fake images, oversized images and secrets', () => {
  assert.throws(() => validateConfig(null), /configuração/i);
  assert.throws(() => validateConfig({ ...defaults(), schemaVersion: 2 }), /versão/i);
  assert.throws(() => validateConfig({ ...defaults(), name: ' ' }), /nome/i);
  assert.throws(() => validateConfig({ ...defaults(), conversation: { ...defaults().conversation, temperature: 5 } }), /temperatura/i);
  assert.throws(() => validateConfig({ ...defaults(), character: { name: 'A', avatar: { mimeType: 'image/png', fileName: 'x', dataUrl: 'data:image/png;base64,aGVsbG8=' } } }), /imagem/i);
  assert.throws(() => validateConfig({ ...defaults(), awsSecretAccessKey: 'secret' }), /campo/i);
  const huge = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
  assert.throws(() => validateConfig({ ...defaults(), character: { name: 'A', avatar: { fileName: 'x.png', mimeType: 'image/png', dataUrl: huge } } }), /5 MB/i);
});
