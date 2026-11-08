import { z } from 'zod';

// Every setting the API reads from the environment is declared here, in one place.
// If anything is missing or malformed, the process exits at boot with a clear message,
// instead of crashing an hour later on the first request that touches it.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_ORIGIN: z.url(),
  DATABASE_URL: z.url(),

  // Uploads
  UPLOAD_DIR: z.string().default('./data/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),
  MAX_DOCS_PER_USER: z.coerce.number().int().min(1).default(20),

  // AI provider. "fake" = offline deterministic embeddings, for tests and local hacking.
  LLM_PROVIDER: z.enum(['gemini', 'fake']).default('gemini'),
  GEMINI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-2'),
  // Must match the vector(N) column; the worker checks this against the database at startup.
  EMBEDDING_DIM: z.coerce.number().int().default(768),
  LLM_MODEL: z.string().default('gemini-3.5-flash'),
  LLM_FAST_MODEL: z.string().default('gemini-3.5-flash-lite'),
  LLM_THINKING: z.enum(['off', 'low', 'high']).default('low'),
  // Below this best-match similarity we answer "not in your documents" without calling the LLM.
  // Measured on the Attention paper: off-topic 0.54, real questions 0.78-0.84.
  ABSTAIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.6),
}).superRefine((env, ctx) => {
  if (env.LLM_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'Required when LLM_PROVIDER=gemini' });
  }
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    console.error('Invalid environment configuration:\n' + z.prettifyError(result.error));
    process.exit(1);
  }
  return result.data;
}
