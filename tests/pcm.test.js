import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmResampler, decodePcm } from '../public/pcm.js';

test('resamples continuous 48kHz capture to 16kHz PCM across arbitrary blocks', () => {
  const r = new PcmResampler(48000, 16000, 512);
  const chunks = [];
  for (let i = 0; i < 48000; i += 128) chunks.push(...r.process(new Float32Array(Math.min(128, 48000 - i)).fill(0.5)));
  assert.equal(chunks.length, 31);
  assert.equal(chunks[0].byteLength, 1024);
  const view = new DataView(chunks[0]);
  assert.equal(view.getInt16(0, true), 16384);
  const floats = decodePcm(chunks[0]);
  assert.equal(floats.length, 512);
  assert.equal(floats[0], 0.5);
});
test('clips PCM, handles native 16k capture and rejects odd-byte playback', () => {
  const r = new PcmResampler(16000, 16000, 2);
  const [chunk] = r.process(new Float32Array([-2, 2]));
  assert.equal(new DataView(chunk).getInt16(0, true), -32768);
  assert.equal(new DataView(chunk).getInt16(2, true), 32767);
  assert.throws(() => decodePcm(new ArrayBuffer(3)), /PCM/i);
});
