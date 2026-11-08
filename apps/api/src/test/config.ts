import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.ts';

// One config for all tests. Uploads go to a fresh temp folder per test process.
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    LOG_LEVEL: 'fatal',
    WEB_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgres://unused-in-tests/db',
    UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'documind-test-')),
    MAX_UPLOAD_MB: 5,
    MAX_DOCS_PER_USER: 20,
    LLM_PROVIDER: 'fake',
    GEMINI_API_KEY: undefined,
    EMBEDDING_MODEL: 'fake-hash-embedder',
    EMBEDDING_DIM: 768,
    LLM_MODEL: 'fake-model',
    LLM_FAST_MODEL: 'fake-model',
    LLM_THINKING: 'off',
    ABSTAIN_SIMILARITY: 0.05, // fake embeddings have low similarities; tests set it when testing abstention
    ...overrides,
  };
}
