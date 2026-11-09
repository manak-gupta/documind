import { CITATIONS_DELIMITER, NOT_FOUND } from '../chat/prompt.ts';
import { type GenerateRequest, type LlmProvider, type StreamEvent, collect } from './provider.ts';

// Offline stand-in for a real model, used by tests, end-to-end tests and demo mode.
// By default it behaves like a well-instructed model following DocuMind's answer protocol:
// it answers with the first sentence of source 1, cites it, and quotes it verbatim, so the
// whole pipeline (streaming, citation verification, viewer highlight) runs with no API key.
export function extractiveReply(req: GenerateRequest): string {
  const last = req.messages.at(-1)?.text ?? '';
  if (req.tier === 'fast') {
    // Follow-up rewriting: return the latest question unchanged.
    return /Latest question: (.*)$/s.exec(last)?.[1]?.trim() ?? last;
  }
  const source = /<source id="1"[^>]*>\n([\s\S]*?)\n<\/source>/.exec(last)?.[1];
  if (!source) return NOT_FOUND;
  const sentence = (source.split(/(?<=[.!?])\s+/)[0] ?? source).slice(0, 220).trim();
  return `According to your documents: ${sentence} [1]\n${CITATIONS_DELIMITER}\n${JSON.stringify({ source: 1, quote: sentence })}`;
}

// Test double: replies with whatever the `reply` function returns for a request, streamed in
// small pieces (to exercise the streaming code paths), and records every request it receives.
export class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  readonly requests: GenerateRequest[] = [];
  private readonly reply: (req: GenerateRequest) => string;

  constructor(reply: (req: GenerateRequest) => string = extractiveReply) {
    this.reply = reply;
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const text = this.reply(req);
    for (let i = 0; i < text.length; i += 7) {
      if (req.signal?.aborted) throw new Error('aborted');
      yield { type: 'text', text: text.slice(i, i + 7) };
    }
    yield { type: 'done', usage: { inputTokens: 100, outputTokens: Math.ceil(text.length / 4) }, model: 'fake-model' };
  }

  complete(req: GenerateRequest) {
    return collect(this.stream(req));
  }
}
