import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import type { Embedder } from '../llm/embedder.ts';
import { ApiError } from '../llm/http.ts';
import type { LlmMessage, LlmProvider } from '../llm/provider.ts';
import { requireAuth } from '../auth/routes.ts';
import { HttpError } from '../http/errors.ts';
import { openSse, type SseStream } from '../http/sse.ts';
import { answerQuestion, type AnswerResult, type TraceChunk } from './answer.ts';
import { cacheKey, getCached, setCached } from './cache.ts';
import { enforceLimits, type Limits } from './limits.ts';

const IdParams = z.object({ id: z.uuid() });
const AskBody = z.object({
  question: z.string().trim().min(2).max(1000),
  documentIds: z.array(z.uuid()).max(50).optional(),
});

export interface ChatDeps {
  db: Db;
  embedder: Embedder;
  llm: LlmProvider;
  abstainSimilarity: number;
  limits: Limits;
  keywordWeight?: number;
}

interface Trace {
  searchQuery: string;
  topSimilarity: number | null;
  chunks: TraceChunk[];
  timings: AnswerResult['timings'];
  usage: AnswerResult['usage'];
  model: string | null;
  rejectedCitations: number;
  cacheHit?: boolean;
}

interface CachedAnswer {
  result: AnswerResult;
  trace: Trace;
}

export async function chatRoutes(app: FastifyInstance, deps: ChatDeps) {
  const { db } = deps;
  app.addHook('preHandler', requireAuth);

  // Every query includes user_id: that's the access check. Not yours = 404.
  const ownConversation = async (id: string, userId: string) => {
    const { rows } = await db.query<{ id: string; title: string; createdAt: Date }>(
      `SELECT id, title, created_at AS "createdAt" FROM conversations WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Conversation not found');
    return rows[0];
  };

  app.post('/conversations', async (req, reply) => {
    const { rows } = await db.query(
      `INSERT INTO conversations (user_id) VALUES ($1) RETURNING id, title, created_at AS "createdAt"`, [req.user!.id]);
    return reply.code(201).send({ conversation: rows[0] });
  });

  app.get('/conversations', async (req) => {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.created_at AS "createdAt",
              coalesce(max(m.created_at), c.created_at) AS "lastActivityAt"
         FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.user_id = $1
        GROUP BY c.id
        ORDER BY "lastActivityAt" DESC
        LIMIT 100`, [req.user!.id]);
    return { conversations: rows };
  });

  app.get('/conversations/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const conversation = await ownConversation(id, req.user!.id);
    const { rows } = await db.query(
      `SELECT id, role, content, citations, trace, created_at AS "createdAt"
         FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [id]);
    return { conversation, messages: rows };
  });

  app.delete('/conversations/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { rowCount } = await db.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    if (!rowCount) throw new HttpError(404, 'not_found', 'Conversation not found');
    return reply.code(204).send();
  });

  // Ask a question. The response is an SSE stream:
  //   status   {stage}                   rewriting | retrieving | generating
  //   sources  {searchQuery, chunks}     what was retrieved (the "Why this answer?" panel)
  //   token    {text}                    answer text as it's generated
  //   done     {messageId, answer, citations, cacheHit, ...}  the verified final answer
  //   error    {message}
  app.post('/conversations/:id/ask', async (req, reply) => {
    const userId = req.user!.id;
    const { id } = IdParams.parse(req.params);
    // Everything that can fail with a normal HTTP error happens BEFORE the stream opens.
    const body = AskBody.parse(req.body);
    const conversation = await ownConversation(id, userId);
    await enforceLimits(db, userId, deps.limits);

    const { rows: past } = await db.query<{ role: 'user' | 'assistant'; content: string }>(
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 6
       ) recent ORDER BY created_at`, [id]);
    const history: LlmMessage[] = past.map((m) => ({ role: m.role, text: m.content }));

    await db.query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`, [id, body.question]);
    if (conversation.title === 'New conversation') {
      await db.query('UPDATE conversations SET title = $2 WHERE id = $1', [id, body.question.slice(0, 80)]);
    }

    const sse = openSse(reply);

    // Only first questions are cacheable: a follow-up's meaning depends on the conversation.
    const key = history.length ? null : await cacheKey(db, userId, body.question, body.documentIds);
    const cached = key ? await getCached<CachedAnswer>(db, key) : null;
    if (cached) {
      const trace: Trace = { ...cached.trace, cacheHit: true };
      sse.send('sources', { searchQuery: trace.searchQuery, topSimilarity: trace.topSimilarity, chunks: trace.chunks });
      sse.send('token', { text: cached.result.answer });
      await finish(sse, { ...cached.result, usage: null }, trace, true);
      return;
    }

    // If the user closes the tab mid-answer, stop generating: no point spending quota on it.
    const abort = new AbortController();
    sse.onClose(() => abort.abort());

    let result: AnswerResult | null = null;
    let sources: { topSimilarity: number; chunks: TraceChunk[] } | null = null;
    try {
      for await (const event of answerQuestion(deps, { userId, question: body.question, history, documentIds: body.documentIds, signal: abort.signal })) {
        if (event.type === 'done') result = event.result;
        else if (event.type === 'token') sse.send('token', { text: event.text });
        else if (event.type === 'status') sse.send('status', { stage: event.stage });
        else {
          sources = event;
          sse.send('sources', event);
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        req.log.error({ err }, 'answer failed');
        sse.send('error', { message: friendlyError(err) });
      }
      sse.close();
      return;
    }

    const r = result!;
    // Everything the "Why this answer?" panel shows, stored with the answer.
    const trace: Trace = {
      searchQuery: r.searchQuery,
      topSimilarity: sources?.topSimilarity ?? null,
      chunks: sources?.chunks ?? [],
      timings: r.timings,
      usage: r.usage,
      model: r.model,
      rejectedCitations: r.rejectedCitations,
    };
    await finish(sse, r, trace, false);
    // Cache real answers only. "Not found" is cheap to recompute and may change once the
    // user uploads the right document (the corpus version in the key covers that anyway).
    if (key && !r.notFound) await setCached(db, key, { result: r, trace } satisfies CachedAnswer);

    // Store the answer, log the query, and send the final event.
    async function finish(stream: SseStream, res: AnswerResult, t: Trace, cacheHit: boolean) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, role, content, citations, trace)
         VALUES ($1, 'assistant', $2, $3, $4) RETURNING id`,
        [id, res.answer, JSON.stringify(res.citations), JSON.stringify(t)]);
      await db.query(
        `INSERT INTO query_logs (user_id, message_id, rewritten_query, retrieval_ms, ttft_ms, total_ms, input_tokens,
                                 output_tokens, provider, model, citations_rejected, cache_hit, chunk_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::bigint[])`,
        [userId, rows[0]!.id, res.searchQuery, cacheHit ? 0 : res.timings.retrievalMs, cacheHit ? null : res.timings.ttftMs,
         cacheHit ? 0 : res.timings.totalMs, res.usage?.inputTokens ?? 0, res.usage?.outputTokens ?? 0, deps.llm.name,
         res.model, res.rejectedCitations, cacheHit, res.chunkIds]);
      stream.send('done', { messageId: rows[0]!.id, ...res, cacheHit });
      stream.close();
    }
  });
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return 'The AI service is busy right now (free-tier rate limit). Please try again in a minute.';
  }
  if (err instanceof ApiError && err.status === 503) {
    return 'The AI service is overloaded right now. Please try again in a moment.';
  }
  return 'Something went wrong while answering. Please try again.';
}
