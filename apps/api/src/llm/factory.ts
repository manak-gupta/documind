import type { Config } from '../config.ts';
import { type Embedder, FakeEmbedder, GeminiEmbedder } from './embedder.ts';
import { FakeLlm } from './fake-llm.ts';
import { GeminiLlm } from './gemini.ts';
import type { LlmProvider } from './provider.ts';

// The one place that maps LLM_PROVIDER to implementations.
export function createEmbedder(config: Config): Embedder {
  switch (config.LLM_PROVIDER) {
    case 'gemini':
      return new GeminiEmbedder({
        apiKey: config.GEMINI_API_KEY!, // presence enforced by config validation
        model: config.EMBEDDING_MODEL,
        dimensions: config.EMBEDDING_DIM,
      });
    case 'fake':
      return new FakeEmbedder(config.EMBEDDING_DIM);
  }
}

export function createLlm(config: Config): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case 'gemini':
      return new GeminiLlm({
        apiKey: config.GEMINI_API_KEY!,
        model: config.LLM_MODEL,
        fastModel: config.LLM_FAST_MODEL,
        thinking: config.LLM_THINKING,
      });
    case 'fake':
      return new FakeLlm();
  }
}
