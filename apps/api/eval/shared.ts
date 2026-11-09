// Shared helpers for the evaluation scripts.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJsonWithRetry } from '../src/llm/http.ts';

export const EVAL_DIR = fileURLToPath(new URL('.', import.meta.url));
export const CACHE_DIR = join(EVAL_DIR, '.cache');

export interface EvalDoc {
  id: string;
  title: string;
  url: string;
}

export interface EvalItem {
  id: string;
  type: 'synthetic' | 'manual' | 'unanswerable';
  doc: string | null;        // EvalDoc id; null for unanswerable
  pages: number[];           // pages that contain the answer
  question: string;
  answer: string;            // reference answer ("" for unanswerable)
}

export const loadDocs = async (): Promise<EvalDoc[]> => JSON.parse(await readFile(join(EVAL_DIR, 'docs.json'), 'utf8'));

export async function loadDataset(): Promise<EvalItem[]> {
  const text = await readFile(join(EVAL_DIR, 'dataset.jsonl'), 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as EvalItem);
}

// Downloads each PDF once into eval/.cache (git-ignored) and returns its local path.
export async function fetchDoc(doc: EvalDoc): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, `${doc.id}.pdf`);
  if (existsSync(path)) return path;
  // Large downloads occasionally get cut off mid-transfer: retry a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(doc.url, { headers: { 'user-agent': 'documind-eval/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
      await writeFile(path, bytes);
      return path;
    } catch (err) {
      if (attempt >= 4) throw new Error(`Download failed for ${doc.id}: ${(err as Error).message}`);
      await sleep(2_000 * attempt);
    }
  }
}

// Gemini call that must return JSON matching a schema (structured output), used for
// question generation and for the LLM judge. Uses responseJsonSchema: the older responseSchema
// field produced malformed objects on gemini-3.5-flash in testing.
export async function geminiJson<T>(opts: { apiKey: string; model: string; prompt: string; schema: object }): Promise<T> {
  const res = await fetchJsonWithRetry<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>(
    `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: opts.schema,
          maxOutputTokens: 4096,
        },
      }),
    },
    { retries: 6, baseDelayMs: 4_000 },
  );
  const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return JSON.parse(text) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export const pagesOverlap = (start: number, end: number, gold: number[]) => gold.some((p) => p >= start && p <= end);
