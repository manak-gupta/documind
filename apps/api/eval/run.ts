// Runs the evaluation and writes eval/results/<name>.json plus a Markdown summary.
//
//   npm run eval -- --chunk-size 400                         # retrieval only (cheap: embeddings)
//   npm run eval -- --chunk-size 400 --answers --thinking off # + answers, judged by an LLM
//
// Retrieval is scored on page overlap: a retrieved chunk is a hit if it comes from the right
// document and its page range includes a gold page. Answers are graded by an LLM judge against
// the reference answer; unanswerable questions must be declined.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import { ingestDocument } from '../src/ingestion/pipeline.ts';
import { createEmbedder } from '../src/llm/factory.ts';
import type { Embedder } from '../src/llm/embedder.ts';
import { GeminiLlm } from '../src/llm/gemini.ts';
import { hybridSearch } from '../src/retrieval/hybrid.ts';
import { answerQuestion, type AnswerResult } from '../src/chat/answer.ts';
import { CACHE_DIR, EVAL_DIR, type EvalItem, fetchDoc, geminiJson, loadDataset, loadDocs, pagesOverlap, percentile, sleep } from './shared.ts';

const { values: args } = parseArgs({
  options: {
    'chunk-size': { type: 'string', default: '400' },
    overlap: { type: 'string' },
    modes: { type: 'string', default: 'hybrid,vector,keyword' },
    answers: { type: 'boolean', default: false },
    thinking: { type: 'string', default: 'low' },
    name: { type: 'string' },
    'pause-ms': { type: 'string', default: '2000' },
    'keyword-weights': { type: 'string', default: '1' },  // e.g. "1,0.5,0.25" for a weighted-RRF sweep
    'reuse-index': { type: 'boolean', default: false },   // skip re-embedding if this config is already indexed
    'answer-keyword-weight': { type: 'string' },          // RRF keyword weight for the answer run (default: config)
  },
});
const keywordWeights = args['keyword-weights']!.split(',').map(Number);

const chunkSize = Number(args['chunk-size']);
const overlap = args.overlap ? Number(args.overlap) : Math.round(chunkSize * 0.15);
const thinking = args.thinking as 'default' | 'off' | 'low' | 'high';
const name = args.name ?? `c${chunkSize}${args.answers ? `-answers-thinking-${thinking}` : '-retrieval'}`;
const modes = args.modes!.split(',') as ('hybrid' | 'vector' | 'keyword')[];

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const answerKeywordWeight = args['answer-keyword-weight'] ? Number(args['answer-keyword-weight']) : config.RRF_KEYWORD_WEIGHT;

// Every config asks the same 40 questions: query embeddings are cached ON DISK, so they're
// computed once ever, not once per run. (The free tier's daily embedding quota ran out during
// development; this makes re-running the eval nearly free.)
const base = createEmbedder(config);
const cacheFile = join(CACHE_DIR, `query-embeddings-${base.model}-${base.dimensions}.json`);
const queryCache = new Map<string, number[]>(
  existsSync(cacheFile) ? Object.entries(JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, number[]>) : []);
const embedder: Embedder = {
  model: base.model,
  dimensions: base.dimensions,
  embedDocuments: (t) => base.embedDocuments(t),
  embedQuery: async (q) => {
    if (!queryCache.has(q)) {
      queryCache.set(q, await base.embedQuery(q));
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(Object.fromEntries(queryCache)));
    }
    return queryCache.get(q)!;
  },
};

// ---------- 1. Index the documents for this chunking config (in its own eval account) ----------
const email = `eval-c${chunkSize}-o${overlap}@documind.eval`;
const { rows: [user] } = await pool.query<{ id: string }>(
  `INSERT INTO users (email, password_hash) VALUES ($1, 'eval-account-no-login')
   ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`, [email]);
const userId = user!.id;
console.log(`\n== ${name}: chunk ${chunkSize} tokens, overlap ${overlap} ==`);
const docIds = new Map<string, string>();
const evalDocs = await loadDocs();

// --reuse-index keeps every document already indexed for this config and only indexes the
// missing ones. Documents are matched by FILE NAME: ingestion replaces the title with the PDF's
// own title, so matching by title silently failed (and the old code then deleted the index).
const { rows: existing } = await pool.query<{ id: string; filename: string }>(
  `SELECT id, filename FROM documents WHERE user_id = $1 AND status = 'ready'`, [userId]);
if (args['reuse-index']) {
  for (const d of evalDocs) {
    const found = existing.find((e) => e.filename === `${d.id}.pdf`);
    if (found) docIds.set(d.id, found.id);
  }
  await pool.query(`DELETE FROM documents WHERE user_id = $1 AND status <> 'ready'`, [userId]); // half-done leftovers
  console.log(`  reusing ${docIds.size}/${evalDocs.length} indexed documents`);
} else {
  await pool.query('DELETE FROM documents WHERE user_id = $1', [userId]); // fresh index
}

await mkdir(config.UPLOAD_DIR, { recursive: true });
for (const doc of evalDocs.filter((d) => !docIds.has(d.id))) {
  const storageKey = `eval-${randomUUID()}.pdf`;
  await copyFile(await fetchDoc(doc), join(config.UPLOAD_DIR, storageKey));
  const { rows: [d] } = await pool.query<{ id: string }>(
    `INSERT INTO documents (user_id, title, filename, sha256, size_bytes, storage_key)
     VALUES ($1, $2, $3, $4, 0, $5) RETURNING id`, [userId, doc.title, `${doc.id}.pdf`, randomUUID(), storageKey]);
  const t0 = performance.now();
  await ingestDocument(
    { pool, embedder, uploadDir: config.UPLOAD_DIR, chunking: { targetTokens: chunkSize, overlapTokens: overlap } },
    d!.id, { isLastAttempt: true });
  docIds.set(doc.id, d!.id);
  const { rows: [s] } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM chunks WHERE document_id = $1', [d!.id]);
  console.log(`  indexed ${doc.id.padEnd(12)} ${String(s!.n).padStart(4)} chunks  ${Math.round(performance.now() - t0)} ms`);
}
const { rows: [idx] } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM chunks WHERE user_id = $1', [userId]);

const dataset = await loadDataset();
const answerable = dataset.filter((i) => i.type !== 'unanswerable');
const isGold = (item: EvalItem, c: { documentId: string; pageStart: number; pageEnd: number }) =>
  c.documentId === docIds.get(item.doc!) && pagesOverlap(c.pageStart, c.pageEnd, item.pages);

// ---------- 2. Retrieval: Recall@k and MRR per mode ----------
const retrieval: Record<string, { recall1: number; recall3: number; recall8: number; mrr: number; avgSearchMs: number }> = {};
const ranks: Record<string, Record<string, number | null>> = {};
// Each mode once; hybrid once per keyword weight (weighted-RRF sweep).
const variants = modes.flatMap((mode): { mode: typeof mode; w: number; label: string }[] =>
  mode === 'hybrid' ? keywordWeights.map((w) => ({ mode, w, label: w === 1 ? 'hybrid' : `hybrid-kw${w}` })) : [{ mode, w: 1, label: mode }]);
for (const { mode, w, label } of variants) {
  const r: number[] = [];
  const ms: number[] = [];
  ranks[label] = {};
  for (const item of answerable) {
    const res = await hybridSearch(pool, embedder, { userId, query: item.question, mode, limit: 8, keywordWeight: w });
    const rank = res.chunks.findIndex((c) => isGold(item, c)) + 1; // 0 = not found
    r.push(rank);
    ms.push(res.timings.searchMs);
    ranks[label]![item.id] = rank || null;
  }
  const at = (k: number) => r.filter((x) => x > 0 && x <= k).length / r.length;
  retrieval[label] = {
    recall1: at(1), recall3: at(3), recall8: at(8),
    mrr: r.reduce((s, x) => s + (x ? 1 / x : 0), 0) / r.length,
    avgSearchMs: ms.reduce((a, b) => a + b, 0) / ms.length,
  };
  console.log(`  ${label.padEnd(12)} R@1 ${pct(at(1))}  R@3 ${pct(at(3))}  R@8 ${pct(at(8))}  MRR ${retrieval[label]!.mrr.toFixed(3)}`);
}

// ---------- 3. Answers (optional): correctness, citations, abstention, latency ----------
interface AnswerRow {
  id: string; type: EvalItem['type']; question: string; answer: string; verdict: string; reason: string;
  notFound: boolean; citations: number; citationsOnGold: number; rejected: number; ttftMs: number | null; totalMs: number;
}
let answers: Record<string, unknown> | null = null;
const rows: AnswerRow[] = [];
if (args.answers) {
  const llm = new GeminiLlm({
    apiKey: config.GEMINI_API_KEY!, model: config.LLM_MODEL, fastModel: config.LLM_FAST_MODEL, thinking,
    retry: { retries: 6, baseDelayMs: 4_000 },
  });
  for (const [i, item] of dataset.entries()) {
    let result: AnswerResult | null = null;
    for await (const e of answerQuestion({ db: pool, embedder, llm, abstainSimilarity: config.ABSTAIN_SIMILARITY, keywordWeight: answerKeywordWeight },
      { userId, question: item.question, history: [] })) {
      if (e.type === 'done') result = e.result;
    }
    const r = result!;
    let verdict: string;
    let reason = '';
    if (item.type === 'unanswerable') {
      verdict = r.notFound ? 'correct' : 'incorrect';
      reason = r.notFound ? 'declined as expected' : 'answered a question the documents cannot answer';
    } else if (r.notFound) {
      verdict = 'incorrect';
      reason = 'declined an answerable question';
    } else {
      const j = await judge(item, r.answer);
      verdict = j.verdict;
      reason = j.reason;
    }
    const goldCites = r.citations.filter((c) => item.doc && isGold(item, { documentId: c.documentId, pageStart: c.pageStart, pageEnd: c.pageEnd })).length;
    rows.push({
      id: item.id, type: item.type, question: item.question, answer: r.answer, verdict, reason,
      notFound: r.notFound, citations: r.citations.length, citationsOnGold: goldCites, rejected: r.rejectedCitations,
      ttftMs: r.timings.ttftMs, totalMs: r.timings.totalMs,
    });
    console.log(`  [${String(i + 1).padStart(2)}/${dataset.length}] ${verdict.padEnd(9)} ${(r.timings.totalMs / 1000).toFixed(1).padStart(5)}s  ${item.question.slice(0, 70)}`);
    await sleep(Number(args['pause-ms'])); // free-tier rate limits
  }

  const score = (v: string) => (v === 'correct' ? 1 : v === 'partial' ? 0.5 : 0);
  const ans = rows.filter((r) => r.type !== 'unanswerable');
  const none = rows.filter((r) => r.type === 'unanswerable');
  const answered = ans.filter((r) => !r.notFound);
  const withCites = answered.filter((r) => r.citations > 0);
  answers = {
    accuracy: ans.reduce((s, r) => s + score(r.verdict), 0) / ans.length,
    fullyCorrect: ans.filter((r) => r.verdict === 'correct').length / ans.length,
    abstentionAccuracy: none.filter((r) => r.notFound).length / none.length,
    wrongAbstentions: ans.filter((r) => r.notFound).length,
    answersWithGoldCitation: withCites.filter((r) => r.citationsOnGold > 0).length / Math.max(1, answered.length),
    citationPrecision: answered.reduce((s, r) => s + r.citationsOnGold, 0) / Math.max(1, answered.reduce((s, r) => s + r.citations, 0)),
    rejectedCitations: rows.reduce((s, r) => s + r.rejected, 0),
    ttftP50: percentile(rows.flatMap((r) => (r.ttftMs != null ? [r.ttftMs] : [])), 50),
    ttftP95: percentile(rows.flatMap((r) => (r.ttftMs != null ? [r.ttftMs] : [])), 95),
    totalP50: percentile(rows.map((r) => r.totalMs), 50),
    totalP95: percentile(rows.map((r) => r.totalMs), 95),
  };
}

// ---------- 4. Save ----------
const out = {
  name, date: new Date().toISOString(),
  config: { chunkSize, overlap, thinking: args.answers ? thinking : null, answerKeywordWeight: args.answers ? answerKeywordWeight : null, llm: config.LLM_MODEL, embeddings: config.EMBEDDING_MODEL, abstainSimilarity: config.ABSTAIN_SIMILARITY },
  dataset: { total: dataset.length, answerable: answerable.length, unanswerable: dataset.length - answerable.length, chunksIndexed: idx!.n },
  retrieval, answers, ranks, rows,
};
await mkdir(join(EVAL_DIR, 'results'), { recursive: true });
await writeFile(join(EVAL_DIR, 'results', `${name}.json`), JSON.stringify(out, null, 2));
if (answers) {
  const a = answers as Record<string, number | null>;
  console.log(`\n  accuracy ${pct(a.accuracy!)} (fully correct ${pct(a.fullyCorrect!)}) | abstention ${pct(a.abstentionAccuracy!)} | wrong refusals ${a.wrongAbstentions}`);
  console.log(`  answers citing a gold page ${pct(a.answersWithGoldCitation!)} | citation precision ${pct(a.citationPrecision!)} | rejected ${a.rejectedCitations}`);
  console.log(`  first token p50 ${sec(a.ttftP50)} p95 ${sec(a.ttftP95)} | total p50 ${sec(a.totalP50)} p95 ${sec(a.totalP95)}`);
}
console.log(`\nSaved eval/results/${name}.json`);
await pool.end();

// ---------- helpers ----------
async function judge(item: EvalItem, answer: string) {
  return geminiJson<{ verdict: 'correct' | 'partial' | 'incorrect'; reason: string }>({
    apiKey: config.GEMINI_API_KEY!,
    model: config.LLM_MODEL,
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'] },
        reason: { type: 'string' },
      },
      required: ['verdict', 'reason'],
    },
    prompt: `You are grading a document question-answering system. Compare the candidate answer to the reference answer.
- "correct": contains the key facts of the reference (extra correct detail is fine; wording may differ).
- "partial": some key facts right, others missing.
- "incorrect": wrong, contradicts the reference, or doesn't answer.
Ignore citation markers like [1].

Question: ${item.question}
Reference answer: ${item.answer}
Candidate answer: ${answer}`,
  });
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`.padStart(6);
}
function sec(ms: number | null | undefined) {
  return ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`;
}
