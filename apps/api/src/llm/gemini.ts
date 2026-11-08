import { fetchWithRetry, type RetryOptions } from './http.ts';
import { type GenerateRequest, type LlmProvider, type StreamEvent, collect } from './provider.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type Thinking = 'off' | 'low' | 'high';

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

export interface GeminiOptions {
  apiKey: string;
  model: string;      // answers
  fastModel: string;  // helper calls
  thinking: Thinking;
  retry?: RetryOptions;
}

export class GeminiLlm implements LlmProvider {
  readonly name = 'gemini';
  private readonly opts: GeminiOptions;

  constructor(opts: GeminiOptions) {
    this.opts = opts;
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const fast = req.tier === 'fast';
    const model = fast ? this.opts.fastModel : this.opts.model;
    // Thinking runs before the first visible token, so it adds latency. Helper calls skip it.
    const thinking: Thinking = fast ? 'off' : this.opts.thinking;

    const res = await fetchWithRetry(
      `${BASE}/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.text }],
          })),
          generationConfig: {
            maxOutputTokens: req.maxOutputTokens ?? 2048,
            thinkingConfig: thinking === 'off' ? { thinkingBudget: 0 } : { thinkingLevel: thinking },
          },
        }),
        signal: req.signal,
      },
      { timeoutMs: 90_000, ...this.opts.retry },
    );

    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of readSse<GeminiChunk>(res.body!)) {
      if (chunk.promptFeedback?.blockReason) throw new Error(`Blocked by provider: ${chunk.promptFeedback.blockReason}`);
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text && !part.thought) yield { type: 'text', text: part.text };
      }
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0);
      }
    }
    yield { type: 'done', usage: { inputTokens, outputTokens }, model };
  }

  complete(req: GenerateRequest) {
    return collect(this.stream(req));
  }
}

// Minimal Server-Sent Events reader: "data: {json}" lines separated by blank lines.
// Bytes can arrive split anywhere (even mid-line), so we buffer until a full event is in.
export async function* readSse<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) yield JSON.parse(data) as T;
    }
  }
}
