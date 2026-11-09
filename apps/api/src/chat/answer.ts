import type { Db } from '../db/pool.ts';
import type { Embedder } from '../llm/embedder.ts';
import type { LlmMessage, LlmProvider, Usage } from '../llm/provider.ts';
import { hybridSearch, type RetrievedChunk } from '../retrieval/hybrid.ts';
import { type Citation, verifyCitations } from './citations.ts';
import { AnswerStreamSplitter, NOT_FOUND_MESSAGE, SYSTEM_PROMPT, buildSourcesMessage } from './prompt.ts';
import { rewriteQuestion } from './rewrite.ts';

export interface AnswerDeps {
  db: Db;
  embedder: Embedder;
  llm: LlmProvider;
  abstainSimilarity: number;
  keywordWeight?: number; // weighted RRF (see retrieval/hybrid.ts)
}

export interface AskInput {
  userId: string;
  question: string;
  history: LlmMessage[];      // earlier turns of this conversation, oldest first
  documentIds?: string[];
  signal?: AbortSignal;
}

// What the trace panel shows for each retrieved chunk ("Why this answer?").
export type TraceChunk = Omit<RetrievedChunk, 'content'> & { n: number; preview: string };

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  rejectedCitations: number;
  notFound: boolean;
  searchQuery: string;
  chunkIds: string[];
  usage: Usage | null;
  model: string | null;
  timings: { rewriteMs: number; retrievalMs: number; ttftMs: number | null; totalMs: number };
}

export type AskEvent =
  | { type: 'status'; stage: 'rewriting' | 'retrieving' | 'generating' }
  | { type: 'sources'; searchQuery: string; topSimilarity: number; chunks: TraceChunk[] }
  | { type: 'token'; text: string }
  | { type: 'done'; result: AnswerResult };

// The full question -> cited answer flow, as a stream of events.
// Independent of HTTP: the API route forwards these events over SSE, and the eval harness
// consumes the same generator to score answers.
export async function* answerQuestion(deps: AnswerDeps, input: AskInput): AsyncGenerator<AskEvent> {
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);

  // 1. Resolve follow-ups ("what about the decoder?") into a standalone question.
  if (input.history.length) yield { type: 'status', stage: 'rewriting' };
  const searchQuery = await rewriteQuestion(deps.llm, input.history, input.question, input.signal);
  const rewriteMs = since();

  // 2. Retrieve.
  yield { type: 'status', stage: 'retrieving' };
  const search = await hybridSearch(deps.db, deps.embedder, {
    userId: input.userId, query: searchQuery, documentIds: input.documentIds, keywordWeight: deps.keywordWeight,
  });
  const retrievalMs = since() - rewriteMs;
  const chunks = search.chunks;
  yield {
    type: 'sources',
    searchQuery,
    topSimilarity: search.topSimilarity,
    chunks: chunks.map(({ content, ...meta }, i) => ({ ...meta, n: i + 1, preview: content.slice(0, 280) })),
  };

  const base = { searchQuery, chunkIds: chunks.map((c) => c.id) };

  // 3. Nothing relevant? Say so without calling the LLM: cheaper, and nothing to hallucinate from.
  // Similarity only: an earlier "unless any keyword matches" exception let off-topic questions
  // through because a single common word ("best") matched somewhere in the paper.
  if (!chunks.length || search.topSimilarity < deps.abstainSimilarity) {
    yield {
      type: 'done',
      result: {
        ...base, answer: NOT_FOUND_MESSAGE, citations: [], rejectedCitations: 0, notFound: true,
        usage: null, model: null, timings: { rewriteMs, retrievalMs, ttftMs: null, totalMs: since() },
      },
    };
    return;
  }

  // 4. Generate, streaming visible text as it arrives.
  yield { type: 'status', stage: 'generating' };
  const splitter = new AnswerStreamSplitter();
  let answerText = '';
  let ttftMs: number | null = null;
  let usage: Usage | null = null;
  let model: string | null = null;

  const stream = deps.llm.stream({
    system: SYSTEM_PROMPT,
    tier: 'main',
    signal: input.signal,
    messages: [
      // Recent turns give the model conversational context. Old [n] markers are stripped:
      // they pointed at the previous turn's sources, not this turn's.
      ...input.history.slice(-4).map((m) => ({ ...m, text: m.text.replace(/\[\d+\]/g, '') })),
      { role: 'user', text: buildSourcesMessage(searchQuery, chunks) },
    ],
  });

  for await (const event of stream) {
    if (event.type === 'done') {
      usage = event.usage;
      model = event.model;
      continue;
    }
    const visible = splitter.push(event.text);
    if (visible) {
      ttftMs ??= since();
      answerText += visible;
      yield { type: 'token', text: visible };
    }
  }
  const tail = splitter.end();
  if (tail) {
    answerText += tail;
    yield { type: 'token', text: tail };
  }

  // 5. Verify citations against the sources we actually sent.
  if (splitter.notFound) {
    yield {
      type: 'done',
      result: {
        ...base, answer: NOT_FOUND_MESSAGE, citations: [], rejectedCitations: 0, notFound: true,
        usage, model, timings: { rewriteMs, retrievalMs, ttftMs, totalMs: since() },
      },
    };
    return;
  }
  const verified = verifyCitations(answerText, splitter.citationsRaw, chunks);
  yield {
    type: 'done',
    result: {
      ...base, answer: verified.answer, citations: verified.citations, rejectedCitations: verified.rejected,
      notFound: false, usage, model, timings: { rewriteMs, retrievalMs, ttftMs, totalMs: since() },
    },
  };
}
