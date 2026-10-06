import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAwsSettings } from '../src/aws-settings.js';
import { defaults, validateConfig } from '../src/config.js';

test('loads AWS profile and region exclusively from the specified .env file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sonic-env-'));
  try {
    const file = join(dir, '.env');
    await writeFile(file, 'AWS_PROFILE="file-profile"\nAWS_REGION=us-west-2\n');
    assert.deepEqual(getAwsSettings(file), { awsProfile: 'file-profile', region: 'us-west-2' });
    await writeFile(file, 'AWS_PROFILE=file-profile\n');
    assert.throws(() => getAwsSettings(file), /AWS_REGION/);
    await writeFile(file, 'AWS_PROFILE=file-profile\nAWS_REGION=invalid\n');
    assert.throws(() => getAwsSettings(file), /AWS_REGION/);
    assert.throws(() => getAwsSettings(join(dir, 'missing')), /\.env/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('preserves legacy model choice but strips profile and region from JSON configs', () => {
  const config = defaults();
  config.connection = { modelId: 'amazon.nova-2-sonic-v1:0', awsProfile: 'untrusted-profile', region: 'us-west-2' };
  assert.deepEqual(validateConfig(config).connection, { modelId: 'amazon.nova-2-sonic-v1:0' });
  assert.equal(Object.hasOwn(defaults().connection, 'awsProfile'), false);
  assert.equal(Object.hasOwn(defaults().connection, 'region'), false);
});
