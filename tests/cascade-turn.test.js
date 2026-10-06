import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDetector, SentenceChunker, PcmAligner, ENDPOINT_MS } from '../src/cascade/turn.js';

const loud = () => Buffer.from(new Int16Array(512).fill(8000).buffer);

test('turn detector waits for mic silence and a stable transcript, then ignores answered results', () => {
  assert.deepEqual(ENDPOINT_MS, { HIGH: 400, MEDIUM: 700, LOW: 1100 });
  const d = new TurnDetector(700, 250);
  assert.equal(d.poll(0), null);
  assert.equal(d.audio(loud(), 0), true);
  assert.equal(d.transcript('a', 'Olá', 50), true);
  d.audio(loud(), 300); d.transcript('a', 'Olá tudo bem', 400);
  assert.equal(d.audio(Buffer.alloc(1024), 600), false);
  assert.equal(d.poll(900), null, 'silêncio de 600 ms');
  assert.equal(d.poll(1000), 'Olá tudo bem');
  assert.equal(d.transcript('a', 'Olá, tudo bem?', 1500), false, 'final atrasado de fala já respondida');
  assert.equal(d.poll(5000), null);
  d.transcript('b', 'Oi', 5100);
  assert.equal(d.poll(5300), null, 'sem voz medida, a espera conta a partir do texto');
  assert.equal(d.poll(5800), 'Oi');
});

test('sentence chunker cuts at punctuation once a sentence is long enough', () => {
  const c = new SentenceChunker(12);
  assert.deepEqual(c.push('Oi. '), []);
  assert.deepEqual(c.push('Tudo bem com você? Eu'), ['Oi. Tudo bem com você? ']);
  assert.deepEqual(c.push(' posso ajudar'), []);
  assert.deepEqual(c.flush(), ['Eu posso ajudar']);
  assert.deepEqual(c.flush(), []);
});

test('PCM aligner keeps 16-bit samples whole across chunks', () => {
  const p = new PcmAligner();
  assert.deepEqual([...p.push(Uint8Array.of(1, 2, 3))], [1, 2]);
  assert.deepEqual([...p.push(Uint8Array.of(4))], [3, 4]);
  assert.equal(p.push(Uint8Array.of()).length, 0);
});

test('speech resumed inside an answered result id counts only the new trailing words', () => {
  const d = new TurnDetector(700, 250);
  d.audio(loud(), 0); d.transcript('a', 'Quero saber o prazo', 50);
  assert.equal(d.poll(1000), 'Quero saber o prazo');
  d.audio(loud(), 1100);
  assert.equal(d.transcript('a', 'Quero saber o prazo de entrega', 1200), true);
  assert.equal(d.text, 'de entrega');
  assert.equal(d.poll(2500), 'de entrega');
  assert.equal(d.transcript('a', 'Quero saber o prazo de entrega.', 3000), false, 'final com pontuação');
  assert.equal(d.poll(5000), null);
});
