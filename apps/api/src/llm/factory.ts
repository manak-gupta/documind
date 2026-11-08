import type { Config } from '../config.ts';
import { type Embedder, FakeEmbedder, GeminiEmbedder } from './embedder.ts';

// The one place that maps LLM_PROVIDER to an implementation.
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
