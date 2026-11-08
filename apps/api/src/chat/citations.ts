import type { RetrievedChunk } from '../retrieval/hybrid.ts';

export interface Citation {
  n: number;               // the marker number in the answer: [n]
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageStart: number;
  pageEnd: number;
  quote: string;           // verified to appear in the chunk; the PDF viewer highlights it
}

export interface VerifiedAnswer {
  answer: string;          // the answer with any unverifiable markers removed
  citations: Citation[];
  rejected: number;        // markers we refused to show (bad source number or unproven quote)
}

const FUZZY_THRESHOLD = 0.85; // share of the quote's words that must appear in one window of the chunk

// LLMs sometimes cite the wrong source, cite a source that doesn't exist, or "quote" a sentence
// they actually paraphrased. So no citation reaches the user unless its quote is really in the
// cited chunk. A marker we can't prove is removed rather than shown with false authority.
export function verifyCitations(answerText: string, citationsRaw: string, sources: RetrievedChunk[]): VerifiedAnswer {
  // "[1, 2]" and "[1,2]" -> "[1][2]", so there's one marker format to handle.
  const answer = answerText.replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_m, list: string) =>
    list.split(',').map((n) => `[${n.trim()}]`).join(''));

  const quotesBySource = new Map<number, string[]>();
  for (const { source, quote } of parseCitationLines(citationsRaw)) {
    quotesBySource.set(source, [...(quotesBySource.get(source) ?? []), quote]);
  }

  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const citations: Citation[] = [];
  const valid = new Set<number>();

  for (const n of [...cited].sort((a, b) => a - b)) {
    const chunk = sources[n - 1];
    if (!chunk) continue; // [9] when we sent 8 sources
    const quote = quotesBySource.get(n)?.find((q) => quoteAppearsIn(q, chunk.content));
    if (!quote) continue;
    valid.add(n);
    citations.push({
      n, chunkId: chunk.id, documentId: chunk.documentId, documentTitle: chunk.documentTitle,
      pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, quote,
    });
  }

  let rejected = 0;
  const cleaned = answer
    .replace(/\s?\[(\d+)\]/g, (marker, n: string) => {
      if (valid.has(Number(n))) return marker;
      rejected++;
      return '';
    })
    .trim();

  return { answer: cleaned, citations, rejected };
}

// Tolerant parser: models sometimes wrap the JSON lines in a code fence or add blank lines.
export function parseCitationLines(raw: string): { source: number; quote: string }[] {
  const out: { source: number; quote: string }[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed) as { source?: unknown; quote?: unknown };
      const source = Number(obj.source);
      if (Number.isInteger(source) && typeof obj.quote === 'string' && obj.quote.trim()) {
        out.push({ source, quote: obj.quote.trim() });
      }
    } catch {
      // Ignore malformed lines; their markers will simply fail verification.
    }
  }
  return out;
}

// Exact match after normalization first; then a fuzzy word-overlap match to tolerate small
// differences from PDF extraction (ligatures, odd spacing, a dropped comma).
export function quoteAppearsIn(quote: string, content: string): boolean {
  const q = normalize(quote);
  const c = normalize(content);
  if (q.length < 8) return false; // too short to prove anything
  if (c.includes(q)) return true;

  const qWords = words(q);
  const cWords = words(c);
  if (qWords.length < 4) return false;

  const need = new Map<string, number>();
  for (const w of qWords) need.set(w, (need.get(w) ?? 0) + 1);

  // Slide a window the size of the quote across the chunk; count overlapping words.
  for (let start = 0; start + qWords.length <= cWords.length + 2; start++) {
    const have = new Map<string, number>();
    for (const w of cWords.slice(start, start + qWords.length + 2)) have.set(w, (have.get(w) ?? 0) + 1);
    let hits = 0;
    for (const [w, n] of need) hits += Math.min(n, have.get(w) ?? 0);
    if (hits / qWords.length >= FUZZY_THRESHOLD) return true;
  }
  return false;
}

function normalize(s: string): string {
  return s
    .normalize('NFKC')                       // ligatures like "ﬁ" -> "fi"
    .toLowerCase()
    .replace(/[‘’“”]/g, (ch) => (ch === '‘' || ch === '’' ? "'" : '"'))
    .replace(/[‐-―]/g, '-')        // all dash variants -> "-"
    .replace(/­/g, '')                  // soft hyphens
    .replace(/\s+/g, ' ')
    .replace(/^["'\s.…]+|["'\s.…]+$/g, '')   // quote marks / ellipses around the quote
    .trim();
}

const words = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
