import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceLevel, LatencyLog, describeLatency } from '../public/metrics.js';
import { AudioBridge } from '../public/audio.js';

function pcm(values) {
  const buffer = new ArrayBuffer(values.length * 2); const view = new DataView(buffer);
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return buffer;
}

test('measures RMS level of 16-bit PCM chunks', () => {
  assert.equal(voiceLevel(pcm([0, 0, 0, 0])), 0);
  assert.ok(Math.abs(voiceLevel(pcm([16384, -16384, 16384, -16384])) - 0.5) < 1e-9);
  assert.equal(voiceLevel(new ArrayBuffer(0)), 0);
});

test('summarizes latency per source with nearest-rank percentiles', () => {
  const log = new LatencyLog();
  assert.equal(log.summary('perceived'), null);
  for (const ms of [900, 700, 1200, 800, 1000]) log.add('perceived', ms);
  log.add('model', 450);
  assert.deepEqual(log.summary('perceived'), { count: 5, last: 1000, p50: 900, p95: 1200 });
  assert.deepEqual(log.summary('model'), { count: 1, last: 450, p50: 450, p95: 450 });
  assert.deepEqual(describeLatency(log.summary('perceived')), { value: '900 ms', detail: 'p95 1200 ms, última 1000 ms, 5 turnos' });
  assert.deepEqual(describeLatency(log.summary('model')), { value: '450 ms', detail: 'p95 450 ms, última 450 ms, 1 turno' });
  assert.deepEqual(describeLatency(null), { value: '—', detail: 'p50 por turno' });
  assert.throws(() => log.add('other', 1), /fonte/i);
});

function fakeBridge(allowInterruption = true) {
  const sent = []; const latencies = [];
  const bridge = new AudioBridge(chunk => sent.push(chunk), () => {}, ms => latencies.push(ms));
  bridge.context = {
    currentTime: 10, destination: {},
    createBuffer: (channels, length, rate) => ({ duration: length / rate, copyToChannel() {} }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, start() {} }),
  };
  bridge.begin(allowInterruption);
  return { bridge, sent, latencies };
}

test('reports perceived latency once per user utterance at response start', () => {
  const { bridge, sent, latencies } = fakeBridge();
  const before = performance.now();
  bridge.handleCapture(pcm(new Array(512).fill(8000)));
  assert.equal(sent.length, 1);
  assert.ok(bridge.lastVoiceAt >= before);
  bridge.lastVoiceAt -= 500;
  const audio = Buffer.from(new Uint8Array(480)).toString('base64');
  bridge.play(audio, 24000);
  assert.equal(latencies.length, 1);
  assert.ok(latencies[0] >= 500 && latencies[0] < 600, `latência ${latencies[0]}`);
  bridge.play(audio, 24000);
  assert.equal(latencies.length, 1, 'chunks da mesma resposta não medem de novo');
  bridge.interrupt();
  bridge.play(audio, 24000);
  assert.equal(latencies.length, 1, 'sem nova fala não há nova medição');
});

test('ignores silence and muted capture when tracking voice', () => {
  const { bridge, sent } = fakeBridge(false);
  bridge.handleCapture(pcm(new Array(512).fill(10)));
  assert.equal(bridge.lastVoiceAt, null);
  bridge.nodes.add({});
  bridge.handleCapture(pcm(new Array(512).fill(8000)));
  assert.equal(bridge.lastVoiceAt, null, 'microfone silenciado durante a resposta');
  assert.equal(new Int16Array(sent[1])[0], 0);
});
