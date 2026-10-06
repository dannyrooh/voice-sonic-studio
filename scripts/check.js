import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
for (const directory of ['src', 'public', 'scripts']) {
  for (const name of await readdir(directory)) if (name.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
  }
}
console.log('Sintaxe JavaScript verificada.');
