// Generates small, valid, text-based PDFs for tests, so the repo needs no binary fixtures.
// Each page is a list of lines; each line has a font size (bigger = heading).

export interface FixtureLine {
  text: string;
  size?: number; // points, default 11
}

export function makePdf(pages: FixtureLine[][], title?: string): Buffer {
  const objects: string[] = []; // objects[i] is object number i + 1
  const add = (body: string) => objects.push(body);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  // 1 catalog, 2 page tree, 3 font, 4 info; then (page, content) pairs from 5.
  const pageIds = pages.map((_, i) => 5 + i * 2);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  add(`<< /Title (${esc(title ?? '')}) /Producer (documind tests) >>`);

  pages.forEach((lines, i) => {
    let y = 750;
    const ops = lines.map(({ text, size = 11 }) => {
      y -= size * 1.6;
      return `BT /F1 ${size} Tf 72 ${y.toFixed(1)} Td (${esc(text)}) Tj ET`;
    });
    const stream = ops.join('\n');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`);
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });

  // Assemble with a correct cross-reference table (byte offset of every object).
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
