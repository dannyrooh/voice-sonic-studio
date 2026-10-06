import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

export function getAwsSettings(file = fileURLToPath(new URL('../.env', import.meta.url))) {
  let values;
  try { values = parseEnv(readFileSync(file, 'utf8')); }
  catch { throw new Error('Não foi possível ler o .env na raiz do projeto. Configure AWS_PROFILE e AWS_REGION.'); }
  const awsProfile = values.AWS_PROFILE?.trim();
  const region = values.AWS_REGION?.trim();
  if (!awsProfile) throw new Error('Defina AWS_PROFILE no .env da raiz do projeto.');
  if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('Defina uma AWS_REGION válida no .env da raiz do projeto.');
  return Object.freeze({ awsProfile, region });
}
