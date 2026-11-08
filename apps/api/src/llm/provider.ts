// Provider-agnostic text generation. The chat code depends only on this interface;
// Gemini is one implementation, and adding Claude/Groq/Ollama means one more class.

export interface LlmMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface GenerateRequest {
  system: string;
  messages: LlmMessage[];
  tier?: 'main' | 'fast';         // main = answers; fast = small helper tasks (rewriting)
  maxOutputTokens?: number;
  signal?: AbortSignal;           // cancel mid-stream when the user disconnects
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;           // visible answer + hidden reasoning ("thinking") tokens
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; usage: Usage; model: string };

export interface LlmProvider {
  readonly name: string;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
  complete(req: GenerateRequest): Promise<{ text: string; usage: Usage; model: string }>;
}

// Shared helper: drain a stream into one result.
export async function collect(stream: AsyncIterable<StreamEvent>) {
  let text = '';
  for await (const e of stream) {
    if (e.type === 'text') text += e.text;
    else return { text, usage: e.usage, model: e.model };
  }
  throw new Error('stream ended without a done event');
}
