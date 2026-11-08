import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RetrievedChunk } from '../retrieval/hybrid.ts';
import { parseCitationLines, quoteAppearsIn, verifyCitations } from './citations.ts';

const src = (content: string, i: number): RetrievedChunk => ({
  id: `c${i}`, documentId: `d${i}`, documentTitle: `Doc ${i}`, ordinal: 0, pageStart: i + 1, pageEnd: i + 1,
  heading: null, content, score: 1, vectorRank: 1, keywordRank: null, similarity: 0.8,
});

const sources = [
  src('The encoder is composed of a stack of N = 6 identical layers. Each layer has two sub-layers.', 0),
  src('We used the Adam optimizer with β1 = 0.9, β2 = 0.98 and ε = 10^-9.', 1),
];
const lines = (...objs: object[]) => objs.map((o) => JSON.stringify(o)).join('\n');

test('a citation whose quote is in the cited source is kept, with page info', () => {
  const r = verifyCitations('The encoder has 6 layers [1].', lines({ source: 1, quote: 'composed of a stack of N = 6 identical layers' }), sources);
  assert.equal(r.answer, 'The encoder has 6 layers [1].');
  assert.equal(r.rejected, 0);
  assert.deepEqual(r.citations.map((c) => [c.n, c.chunkId, c.pageStart]), [[1, 'c0', 1]]);
});

test('a quote attributed to the WRONG source is rejected and its marker removed', () => {
  const r = verifyCitations('The encoder has 6 layers [2].', lines({ source: 2, quote: 'composed of a stack of N = 6 identical layers' }), sources);
  assert.equal(r.answer, 'The encoder has 6 layers.');
  assert.equal(r.rejected, 1);
  assert.deepEqual(r.citations, []);
});

test('a source number that was never sent is rejected', () => {
  const r = verifyCitations('Claim [7].', lines({ source: 7, quote: 'anything at all here' }), sources);
  assert.equal(r.answer, 'Claim.');
  assert.equal(r.rejected, 1);
});

test('a paraphrase presented as a quote is rejected', () => {
  const r = verifyCitations('Six layers [1].', lines({ source: 1, quote: 'the encoder uses six stacked transformer blocks' }), sources);
  assert.equal(r.rejected, 1);
});

test('a marker with no quote at all is rejected', () => {
  const r = verifyCitations('Six layers [1]. Adam [2].', lines({ source: 2, quote: 'We used the Adam optimizer' }), sources);
  assert.equal(r.answer, 'Six layers. Adam [2].');
  assert.equal(r.rejected, 1);
});

test('"[1, 2]" is normalized to separate markers, each verified on its own', () => {
  const r = verifyCitations('Both [1, 2].', lines(
    { source: 1, quote: 'Each layer has two sub-layers' },
    { source: 2, quote: 'We used the Adam optimizer' },
  ), sources);
  assert.equal(r.answer, 'Both [1][2].');
  assert.equal(r.citations.length, 2);
});

test('small PDF extraction differences are tolerated (case, spacing, curly quotes, ligatures)', () => {
  assert.ok(quoteAppearsIn('“THE ENCODER  is composed of a stack”', sources[0]!.content));
  assert.ok(quoteAppearsIn('ﬁve ﬁnal ﬁgures were shown', 'five final figures were shown in the appendix'));
  // One word different out of many (e.g. an extraction glitch): still the same sentence.
  assert.ok(quoteAppearsIn('The encoder is made of a stack of N = 6 identical layers', sources[0]!.content));
  // Two words changed is a paraphrase, not a quote.
  assert.ok(!quoteAppearsIn('The encoder is built from a stack of N = 6 identical layers', sources[0]!.content));
  assert.ok(!quoteAppearsIn('layers', sources[0]!.content), 'too short to prove anything');
});

test('citation lines are parsed even inside a code fence or with junk lines', () => {
  const raw = '```json\n{"source": 1, "quote": "a b c d"},\nnot json\n{"source": "2", "quote": "e f g h"}\n```';
  assert.deepEqual(parseCitationLines(raw), [{ source: 1, quote: 'a b c d' }, { source: 2, quote: 'e f g h' }]);
});
