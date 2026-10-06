import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig, ValidationError } from './config.js';

function checkId(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new ValidationError('Identificador de configuração inválido.');
}
export class ConfigStore {
  constructor(directory) { this.directory = directory; this.pending = Promise.resolve(); }
  async get(id) {
    checkId(id);
    const value = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'));
    return { ...validateConfig(value), id, createdAt: value.createdAt, updatedAt: value.updatedAt };
  }
  async list() {
    await mkdir(this.directory, { recursive: true });
    const files = await readdir(this.directory);
    const result = [];
    for (const file of files.filter(name => /^[0-9a-f-]+\.json$/.test(name))) {
      const c = await this.get(file.slice(0, -5));
      result.push({ id: c.id, name: c.name, characterName: c.character.name, updatedAt: c.updatedAt });
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  save(input, id) {
    const action = this.pending.then(async () => {
      if (id) checkId(id);
      const config = validateConfig(input);
      const previous = id ? await this.get(id) : null;
      const timestamp = new Date().toISOString();
      const saved = { ...config, id: id || randomUUID(), createdAt: previous?.createdAt || timestamp, updatedAt: timestamp };
      await mkdir(this.directory, { recursive: true });
      const target = join(this.directory, `${saved.id}.json`);
      const temporary = join(this.directory, `${saved.id}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(saved, null, 2), { flag: 'wx' });
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return saved;
    });
    this.pending = action.catch(() => {});
    return action;
  }
}
