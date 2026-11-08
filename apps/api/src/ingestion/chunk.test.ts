import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedPage } from './parse.ts';
import { chunkPages, embeddingText, estimateTokens } from './chunk.ts';

// Builds pages directly (no PDF needed): each line is body text unless given a size.
const page = (pageNumber: number, lines: (string | [string, number])[]): ParsedPage => ({
  pageNumber,
  lines: lines.map((l) => (typeof l === 'string' ? { text: l, fontSize: 11 } : { text: l[0], fontSize: l[1] })),
});

// "Sentence 7 talks about topic 7 in some detail." (~12 tokens each)
const sentences = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence ${from + i} talks about topic ${from + i} in some detail.`);

test('chunks stay near the target size and never exceed the maximum', () => {
  const chunks = chunkPages([page(1, sentences(0, 200))], { targetTokens: 100, overlapTokens: 20 });
  assert.ok(chunks.length > 10);
  for (const c of chunks) assert.ok(c.tokenCount <= 150, `chunk ${c.ordinal} has ${c.tokenCount} tokens`);
  assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i));
});

test('consecutive chunks overlap by whole sentences', () => {
  const chunks = chunkPages([page(1, sentences(0, 60))], { targetTokens: 100, overlapTokens: 30 });
  for (let i = 1; i < chunks.length; i++) {
    const prevLastSentence = chunks[i - 1]!.content.split(/(?<=\.) /).at(-1)!;
    const firstSentence = chunks[i]!.content.split(/(?<=\.) /)[0]!;
    assert.ok(chunks[i]!.content.includes(prevLastSentence), `chunk ${i} repeats the end of chunk ${i - 1}`);
    assert.ok(chunks[i - 1]!.content.includes(firstSentence), `chunk ${i} begins inside chunk ${i - 1}`);
  }
});

test('no sentence is ever cut in half', () => {
  const all = sentences(0, 80);
  const chunks = chunkPages([page(1, all)], { targetTokens: 90, overlapTokens: 20 });
  const text = chunks.map((c) => c.content).join(' ');
  for (const s of all) assert.ok(text.includes(s), `"${s}" survives intact`);
});

test('a chunk that crosses a page break records both pages', () => {
  const chunks = chunkPages([page(1, sentences(0, 3)), page(2, sentences(3, 3))], { targetTokens: 400 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.pageStart, 1);
  assert.equal(chunks[0]!.pageEnd, 2);
});

test('headings start a new chunk and label the chunks under them', () => {
  const chunks = chunkPages([
    page(1, [['Introduction', 18], ...sentences(0, 5), ['Results', 18], ...sentences(5, 5)]),
  ]);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.heading, 'Introduction');
  assert.equal(chunks[1]!.heading, 'Results');
  assert.ok(chunks[1]!.content.startsWith('Sentence 5'), 'no overlap leaks across sections');
});

test('a large line that ends like a sentence is body text, not a heading', () => {
  const chunks = chunkPages([page(1, [['This big line is just emphasis.', 18], ...sentences(0, 5)])]);
  assert.equal(chunks[0]!.heading, null);
  assert.ok(chunks[0]!.content.startsWith('This big line'));
});

test('words hyphenated across a line break are re-joined', () => {
  const chunks = chunkPages([page(1, ['The report contains infor-', 'mation about revenue.'])]);
  assert.equal(chunks[0]!.content, 'The report contains information about revenue.');
});

test('text without punctuation (tables) is split by words instead of one giant chunk', () => {
  const table = Array.from({ length: 500 }, (_, i) => `cell${i}`).join(' ');
  const chunks = chunkPages([page(1, [table])], { targetTokens: 100 });
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.tokenCount <= 150);
});

test('an empty document produces no chunks', () => {
  assert.deepEqual(chunkPages([page(1, [])]), []);
});

test('embedding text carries the document title and section as context', () => {
  const [chunk] = chunkPages([page(1, [['Results', 18], 'Revenue grew 12%.'])]);
  assert.equal(embeddingText(chunk!, 'Acme Annual Report'), 'Acme Annual Report › Results\n\nRevenue grew 12%.');
  assert.equal(estimateTokens('abcd'), 1);
});
