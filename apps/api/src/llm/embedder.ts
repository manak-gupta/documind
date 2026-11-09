import { createHash } from 'node:crypto';
import { fetchJsonWithRetry, type RetryOptions } from './http.ts';
import { RateLimiter } from './rate-limiter.ts';

// The rest of the app only knows this interface. Swapping Gemini for another provider means
// writing one new class, not touching ingestion or search.
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  // Documents and queries are embedded differently: retrieval models are trained so that a
  // QUESTION lands near the PASSAGE that answers it, not near other questions.
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

// ---------------- Gemini ----------------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiBatchResponse {
  embeddings: { values: number[] }[];
}

export class GeminiEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly retry: RetryOptions;
  private readonly limiter: RateLimiter;
  private readonly batchSize: number;

  constructor(opts: { apiKey: string; model: string; dimensions: number; requestsPerMinute?: number; retry?: RetryOptions }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.retry = opts.retry ?? {};
    // Each text in a batch counts as one request against the provider's per-minute quota.
    const rpm = opts.requestsPerMinute ?? 90;
    this.limiter = new RateLimiter({ max: rpm });
    this.batchSize = Math.min(100, rpm); // the API accepts at most 100 texts per batch call
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.batch(texts.slice(i, i + this.batchSize), 'RETRIEVAL_DOCUMENT')));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.batch([text], 'RETRIEVAL_QUERY'))[0]!;
  }

  private async batch(texts: string[], taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'): Promise<number[][]> {
    await this.limiter.acquire(texts.length);
    const res = await fetchJsonWithRetry<GeminiBatchResponse>(
      `${GEMINI_BASE}/models/${this.model}:batchEmbedContents`,
      {
        method: 'POST',
        // Key in a header, not the URL: URLs end up in proxy and server logs.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: this.dimensions,
          })),
        }),
      },
      this.retry,
    );

    if (res.embeddings?.length !== texts.length) {
      throw new Error(`Embedding API returned ${res.embeddings?.length ?? 0} vectors for ${texts.length} texts`);
    }
    return res.embeddings.map((e) => {
      if (e.values.length !== this.dimensions) {
        throw new Error(`Expected ${this.dimensions} dimensions, got ${e.values.length}`);
      }
      return e.values;
    });
  }
}

// ---------------- Fake (tests and offline development) ----------------

// Deterministic "hashed bag of words": each word adds weight to a few fixed dimensions.
// Texts sharing words get similar vectors, so retrieval tests behave sensibly with
// no network, no API key and no quota.
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-hash-embedder';
  readonly dimensions: number;

  constructor(dimensions = 768) {
    this.dimensions = dimensions;
  }

  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string) {
    return this.vector(text);
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const h = createHash('sha256').update(word).digest();
      for (let k = 0; k < 4; k++) v[h.readUInt16BE(k * 2) % this.dimensions]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

// pgvector's text format: '[0.1,0.2,...]'
export const toPgVector = (v: number[]) => `[${v.join(',')}]`;
