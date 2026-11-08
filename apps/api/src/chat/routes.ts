import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import type { Embedder } from '../llm/embedder.ts';
import { ApiError } from '../llm/http.ts';
import type { LlmMessage, LlmProvider } from '../llm/provider.ts';
import { requireAuth } from '../auth/routes.ts';
import { HttpError } from '../http/errors.ts';
import { openSse } from '../http/sse.ts';
import { answerQuestion, type AnswerResult } from './answer.ts';

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
      `SELECT id, role, content, citations, created_at AS "createdAt"
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
  //   done     {messageId, answer, citations, ...}  the verified final answer
  //   error    {message}
  app.post('/conversations/:id/ask', async (req, reply) => {
    const userId = req.user!.id;
    const { id } = IdParams.parse(req.params);
    const body = AskBody.parse(req.body); // validate BEFORE opening the stream, so bad input is a normal 400
    const conversation = await ownConversation(id, userId);

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
    // If the user closes the tab mid-answer, stop generating: no point spending quota on it.
    const abort = new AbortController();
    sse.onClose(() => abort.abort());

    let result: AnswerResult | null = null;
    try {
      for await (const event of answerQuestion(deps, { userId, question: body.question, history, documentIds: body.documentIds, signal: abort.signal })) {
        if (event.type === 'done') result = event.result;
        else if (event.type === 'token') sse.send('token', { text: event.text });
        else if (event.type === 'status') sse.send('status', { stage: event.stage });
        else sse.send('sources', event);
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
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, content, citations) VALUES ($1, 'assistant', $2, $3) RETURNING id`,
      [id, r.answer, JSON.stringify(r.citations)]);
    await db.query(
      `INSERT INTO query_logs (user_id, message_id, rewritten_query, retrieval_ms, ttft_ms, total_ms,
                               input_tokens, output_tokens, provider, model, citations_rejected, chunk_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::bigint[])`,
      [userId, rows[0]!.id, r.searchQuery, r.timings.retrievalMs, r.timings.ttftMs, r.timings.totalMs,
       r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0, deps.llm.name, r.model, r.rejectedCitations, r.chunkIds]);

    sse.send('done', { messageId: rows[0]!.id, ...r });
    sse.close();
  });
}

function friendlyError(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return 'The AI service is busy right now (free-tier rate limit). Please try again in a minute.';
  }
  return 'Something went wrong while answering. Please try again.';
}
