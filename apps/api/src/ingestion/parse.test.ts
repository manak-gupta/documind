import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePdf } from './parse.ts';
import { makePdf } from '../test/pdf.ts';

test('extracts text per page with page numbers, font sizes and the metadata title', async () => {
  const pdf = makePdf(
    [
      [
        { text: 'Annual Report 2024', size: 20 },
        { text: 'Revenue grew 12% in APAC, driven by new enterprise customers.' },
        { text: 'Costs (excluding one-offs) were flat.' },
      ],
      [
        { text: 'Outlook', size: 16 },
        { text: 'We expect growth of 8-10% next year.' },
      ],
    ],
    'Acme Annual Report',
  );

  const parsed = await parsePdf(new Uint8Array(pdf));

  assert.equal(parsed.title, 'Acme Annual Report');
  assert.equal(parsed.pageCount, 2);
  assert.deepEqual(parsed.scannedPages, []);
  assert.deepEqual(parsed.pages.map((p) => p.pageNumber), [1, 2]);

  const [heading, body, parens] = parsed.pages[0]!.lines;
  assert.equal(heading?.text, 'Annual Report 2024');
  assert.equal(heading?.fontSize, 20);
  assert.equal(body?.text, 'Revenue grew 12% in APAC, driven by new enterprise customers.');
  assert.equal(body?.fontSize, 11);
  assert.equal(parens?.text, 'Costs (excluding one-offs) were flat.');
  assert.equal(parsed.pages[1]!.lines[0]?.text, 'Outlook');
});

test('pages without a text layer are reported as scanned', async () => {
  const pdf = makePdf([[{ text: 'This page has plenty of real, extractable text on it.' }], []]);
  const parsed = await parsePdf(new Uint8Array(pdf));
  assert.deepEqual(parsed.scannedPages, [2]);
});

test('a corrupt file is rejected with an error, not a hang or crash', async () => {
  await assert.rejects(parsePdf(new Uint8Array(Buffer.from('%PDF-1.4\nthis is not really a pdf'))));
});
