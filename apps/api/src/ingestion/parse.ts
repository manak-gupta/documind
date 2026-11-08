import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface Line {
  text: string;
  fontSize: number; // used by the chunker to detect headings
}

export interface ParsedPage {
  pageNumber: number; // 1-based, as shown in PDF viewers
  lines: Line[];
}

export interface ParsedPdf {
  title: string | null;      // from the PDF's metadata, if the author set one
  pageCount: number;
  pages: ParsedPage[];
  scannedPages: number[];    // pages with (almost) no text layer: images of text, which we can't read without OCR
}

// pdfjs needs its bundled standard fonts (Helvetica, Times, ...) to measure text correctly.
const require = createRequire(import.meta.url);
// pdfjs requires a "/"-terminated path with forward slashes, even on Windows.
const STANDARD_FONTS =
  join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').split(sep).join('/') + '/';

const MIN_CHARS_FOR_TEXT_PAGE = 20;

export async function parsePdf(data: Uint8Array): Promise<ParsedPdf> {
  // pdfjs v6 no longer evaluates code from fonts at all (the CVE-2024-4367 class of bug),
  // and XFA forms are off by default, so a malicious PDF has little attack surface here.
  const task = getDocument({
    data,
    standardFontDataUrl: STANDARD_FONTS,
    stopAtErrors: false, // recover what text we can from slightly broken PDFs
    verbosity: 0,        // errors only
  });

  try {
    const pdf = await task.promise;
    const meta = await pdf.getMetadata().catch(() => null);
    const info = meta?.info as { Title?: string } | undefined;
    const pages: ParsedPage[] = [];
    const scannedPages: number[] = [];

    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const lines = toLines(content.items as TextItem[]);
      page.cleanup(); // free this page's memory before moving on (big PDFs)

      const chars = lines.reduce((sum, l) => sum + l.text.length, 0);
      if (chars < MIN_CHARS_FOR_TEXT_PAGE) scannedPages.push(n);
      pages.push({ pageNumber: n, lines });
    }

    return { title: info?.Title?.trim() || null, pageCount: pdf.numPages, pages, scannedPages };
  } finally {
    await task.destroy(); // releases the parser's memory and worker even if parsing failed
  }
}

interface TextItem {
  str: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY, x, y]
  height: number;
  hasEOL?: boolean;
}

// pdfjs returns text in small runs ("items"), not lines. We rebuild lines: a new line starts
// when the item says so (hasEOL) or when its baseline (y) moves noticeably.
function toLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  let text = '';
  let fontSize = 0;
  let lastY: number | null = null;

  const flush = () => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) lines.push({ text: clean, fontSize: Math.round(fontSize * 10) / 10 });
    text = '';
    fontSize = 0;
  };

  for (const item of items) {
    if (!('str' in item)) continue; // marked-content markers have no text
    const y = item.transform[5] ?? 0;
    const size = Math.abs(item.transform[3] ?? item.height);

    if (lastY !== null && Math.abs(y - lastY) > size * 0.5) flush();
    text += (text && !text.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '') + item.str;
    fontSize = Math.max(fontSize, size);
    lastY = y;
    if (item.hasEOL) {
      flush();
      lastY = null;
    }
  }
  flush();
  return lines;
}
