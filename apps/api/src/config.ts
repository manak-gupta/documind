import { z } from 'zod';

// Every setting the API reads from the environment is declared here, in one place.
// If anything is missing or malformed, the process exits at boot with a clear message,
// instead of crashing an hour later on the first request that touches it.
// (Keys like GEMINI_API_KEY get added in the step that first uses them.)
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_ORIGIN: z.url(),
  DATABASE_URL: z.url(),
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
