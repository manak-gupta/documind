import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findQuote } from './findQuote.ts';

// How pdf.js typically splits one sentence across text items.
const items = ['3.1 Encoder and Decoder Stacks', 'Encoder:', 'The encoder is composed of a stack', 'of N = 6 identical layers.', 'Each layer has two sub-layers.'];

test('finds the items spanning a quote that crosses item boundaries', () => {
  assert.deepEqual(findQuote(items, 'The encoder is composed of a stack of N = 6 identical layers.'), { first: 2, last: 3 });
});

test('is case-, whitespace- and quote-mark-insensitive', () => {
  assert.deepEqual(findQuote(items, '  “the ENCODER is composed   of a stack”'), { first: 2, last: 2 });
});

test('falls back to the start of the quote when the end differs (PDF quirks)', () => {
  const range = findQuote(items, 'The encoder is composed of a stack of N=6 layers [garbled tail]');
  assert.equal(range?.first, 2);
});

test('matches text that the PDF split with odd spacing ("41 . 0" vs "41.0")', () => {
  const r = findQuote(['our big model achieves a BLEU score of 41 . 0, outperforming'], 'achieves a BLEU score of 41.0');
  assert.deepEqual(r, { first: 0, last: 0 });
});

test('returns null when the quote is not on the page', () => {
  assert.equal(findQuote(items, 'chocolate cake recipe with three eggs'), null);
});
