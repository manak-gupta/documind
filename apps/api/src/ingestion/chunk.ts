import type { ParsedPage } from './parse.ts';

export interface Chunk {
  ordinal: number;
  pageStart: number;
  pageEnd: number;
  heading: string | null;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  targetTokens?: number;  // aim for chunks about this big
  overlapTokens?: number; // repeat this much of the previous chunk at the start of the next
  maxTokens?: number;     // hard ceiling; longer "sentences" (tables, lists) are split by words
}

// ~4 characters per token is the usual estimate for English. Exact counts would need the
// model's tokenizer (an API call per chunk); the estimate is accurate enough to size chunks.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

interface Unit {
  text: string;
  page: number;
  tokens: number;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function chunkPages(pages: ParsedPage[], opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 400;
  const overlap = opts.overlapTokens ?? 60;
  const max = opts.maxTokens ?? Math.round(target * 1.5);
  const bodySize = bodyFontSize(pages);

  const chunks: Chunk[] = [];
  let current: Unit[] = [];
  let currentTokens = 0;
  let heading: string | null = null;

  const emit = () => {
    if (!current.length) return;
    const content = current.map((u) => u.text).join(' ');
    chunks.push({
      ordinal: chunks.length,
      pageStart: current[0]!.page,
      pageEnd: current.at(-1)!.page,
      heading,
      content,
      tokenCount: estimateTokens(content),
    });
  };

  // Keep the tail of the finished chunk (whole sentences, up to `overlap` tokens) so a fact
  // that straddles the boundary is fully present in at least one chunk.
  const startNextWithOverlap = () => {
    const tail: Unit[] = [];
    let tokens = 0;
    for (let i = current.length - 1; i > 0; i--) {
      const u = current[i]!;
      if (tokens + u.tokens > overlap) break;
      tail.unshift(u);
      tokens += u.tokens;
    }
    current = tail;
    currentTokens = tokens;
  };

  const add = (unit: Unit) => {
    if (currentTokens + unit.tokens > target && current.length) {
      emit();
      startNextWithOverlap();
    }
    current.push(unit);
    currentTokens += unit.tokens;
  };

  for (const page of pages) {
    for (const block of toBlocks(page, bodySize)) {
      if (block.isHeading) {
        // New section: close the current chunk (no overlap across sections) and relabel.
        emit();
        current = [];
        currentTokens = 0;
        heading = block.text;
        continue;
      }
      for (const sentence of splitSentences(block.text)) {
        for (const piece of splitOversized(sentence, max, target)) {
          add({ text: piece, page: page.pageNumber, tokens: estimateTokens(piece) });
        }
      }
    }
  }
  emit();
  return chunks;
}

// The text that gets embedded: the chunk prefixed with where it comes from.
// "Revenue grew 12%" alone is ambiguous; "Acme Annual Report › Results\n\nRevenue grew 12%" is not.
export function embeddingText(chunk: Chunk, documentTitle: string): string {
  const context = [documentTitle, chunk.heading].filter(Boolean).join(' › ');
  return `${context}\n\n${chunk.content}`;
}

// ---------- helpers ----------

interface Block {
  text: string;
  isHeading: boolean;
}

// Groups a page's lines into headings and runs of body text.
function toBlocks(page: ParsedPage, bodySize: number): Block[] {
  const blocks: Block[] = [];
  let body = '';

  for (const line of page.lines) {
    const looksLikeHeading =
      line.fontSize >= bodySize * 1.15 && line.text.length <= 120 && !/[.,;:]$/.test(line.text);

    if (looksLikeHeading) {
      if (body) blocks.push({ text: body, isHeading: false });
      body = '';
      blocks.push({ text: line.text, isHeading: true });
    } else if (/[A-Za-z]-$/.test(body) && /^[a-z]/.test(line.text)) {
      body = body.slice(0, -1) + line.text; // "infor-" + "mation" -> "information"
    } else {
      body = body ? `${body} ${line.text}` : line.text;
    }
  }
  if (body) blocks.push({ text: body, isHeading: false });
  return blocks;
}

function splitSentences(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment.trim()).filter(Boolean);
}

// Tables and bullet lists often have no sentence punctuation. Split them by words.
function splitOversized(sentence: string, max: number, target: number): string[] {
  if (estimateTokens(sentence) <= max) return [sentence];
  const words = sentence.split(/\s+/);
  const pieces: string[] = [];
  let piece: string[] = [];
  for (const word of words) {
    piece.push(word);
    if (estimateTokens(piece.join(' ')) >= target) {
      pieces.push(piece.join(' '));
      piece = [];
    }
  }
  if (piece.length) pieces.push(piece.join(' '));
  return pieces;
}

// The most common font size, weighted by characters, is the body text size.
function bodyFontSize(pages: ParsedPage[]): number {
  const charsBySize = new Map<number, number>();
  for (const page of pages) {
    for (const line of page.lines) {
      charsBySize.set(line.fontSize, (charsBySize.get(line.fontSize) ?? 0) + line.text.length);
    }
  }
  let best = 0;
  let bestChars = -1;
  for (const [size, chars] of charsBySize) {
    if (chars > bestChars) {
      best = size;
      bestChars = chars;
    }
  }
  return best || 11;
}
