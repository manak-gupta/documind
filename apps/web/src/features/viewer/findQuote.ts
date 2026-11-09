// Finds which text items on a PDF page contain a quote, so the viewer can highlight them.
//
// pdf.js gives a page's text as many small items ("The encoder is", "composed of a", ...).
// We join them into one normalized string, remembering where each item starts and ends,
// search for the normalized quote, and map the match back to item indices.
//
// PDFs are messy (odd spacing, ligatures, hyphenation), so if the full quote isn't found we
// try its first words, then its last words: highlighting the start of the right passage is
// far better than highlighting nothing.

export interface ItemRange {
  first: number;
  last: number;
}

// Double quote marks are dropped entirely (both sides): models often wrap a quote in “…”,
// and a leading quote mark glued to the first word would make the whole match fail.
const normalize = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/["“”]/g, '')
    .replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();

export function findQuote(items: string[], quote: string): ItemRange | null {
  const spans: { start: number; end: number }[] = [];
  let text = '';
  for (const item of items) {
    const n = normalize(item);
    if (text && n) text += ' ';
    spans.push({ start: text.length, end: text.length + n.length });
    text += n;
  }

  const words = normalize(quote).split(' ').filter(Boolean);
  if (!words.length) return null;
  const candidates = [
    words.join(' '),
    words.slice(0, 8).join(' '),
    words.slice(0, 5).join(' '),
    words.slice(-5).join(' '),
  ].filter((c, i, all) => c.length >= 12 && all.indexOf(c) === i);

  for (const needle of candidates) {
    // Also try without spaces: PDFs often split words oddly ("41 . 0" vs "41.0").
    let at = text.indexOf(needle);
    let length = needle.length;
    if (at === -1) {
      const squashed = squash(text);
      const s = squashed.text.indexOf(needle.replace(/ /g, ''));
      if (s === -1) continue;
      at = squashed.map[s]!;
      length = squashed.map[s + needle.replace(/ /g, '').length - 1]! - at + 1;
    }
    const end = at + length;
    const hit = spans.flatMap((sp, i) => (sp.end > at && sp.start < end ? [i] : []));
    if (hit.length) return { first: hit[0]!, last: hit.at(-1)! };
  }
  return null;
}

// Removes spaces, keeping a map from each squashed index back to the original index.
function squash(text: string) {
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') {
      out += text[i];
      map.push(i);
    }
  }
  return { text: out, map };
}
