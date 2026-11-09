import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import type { Embedder } from '../llm/embedder.ts';
import { requireAuth } from '../auth/routes.ts';
import { hybridSearch } from './hybrid.ts';

const SearchBody = z.object({
  query: z.string().trim().min(2).max(500),
  documentIds: z.array(z.uuid()).max(50).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

// Retrieval on its own, without an LLM: powers the "Why this answer?" panel and lets the
// eval harness measure retrieval quality separately from answer quality.
export async function searchRoutes(app: FastifyInstance, opts: { db: Db; embedder: Embedder; keywordWeight?: number }) {
  app.addHook('preHandler', requireAuth);

  app.post('/search', async (req) => {
    const body = SearchBody.parse(req.body);
    return hybridSearch(opts.db, opts.embedder, { userId: req.user!.id, keywordWeight: opts.keywordWeight, ...body });
  });
}
