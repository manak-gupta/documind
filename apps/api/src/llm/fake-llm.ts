import { type GenerateRequest, type LlmProvider, type StreamEvent, collect } from './provider.ts';

// Test double: replies with whatever the `reply` function returns for a request, streamed in
// small pieces (to exercise the streaming code paths), and records every request it receives.
export class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  readonly requests: GenerateRequest[] = [];
  private readonly reply: (req: GenerateRequest) => string;

  constructor(reply: (req: GenerateRequest) => string = () => 'NOT_FOUND') {
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
