import type { Db } from '../db/pool.ts';
import { type Embedder, toPgVector } from '../llm/embedder.ts';

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  pageStart: number;
  pageEnd: number;
  heading: string | null;
  content: string;
  score: number;               // fused RRF score: what the final order is based on
  vectorRank: number | null;   // 1 = closest in meaning; null = not in the vector top-K
  keywordRank: number | null;  // 1 = best keyword match; null = no keyword match
  similarity: number | null;   // cosine similarity to the question (0..1), when vector-matched
}

export interface SearchOptions {
  userId: string;
  query: string;
  documentIds?: string[];  // restrict to these documents; default = the user's whole library
  limit?: number;          // chunks returned to the caller (sent to the LLM)
  candidates?: number;     // how deep each list goes before fusion
}

export interface SearchResult {
  chunks: RetrievedChunk[];
  topSimilarity: number;   // best vector similarity: used to decide "not in your documents"
  timings: { embedMs: number; searchMs: number };
}

// Reciprocal Rank Fusion constant. score = Σ 1 / (K + rank). A larger K flattens the gap
// between rank 1 and rank 2, so a chunk ranked well by BOTH methods beats a chunk ranked
// first by only one. 60 is the value from the original RRF paper and the common default.
const RRF_K = 60;

// Both searches, the fusion, the access check and the join to documents, in ONE query.
//  vec: K nearest chunks by cosine distance (HNSW index)
//  kw:  K best full-text matches (GIN index), with OR semantics, ranked by ts_rank_cd
//  FULL OUTER JOIN keeps chunks found by only one method, with the other rank NULL.
const HYBRID_SQL = `
WITH q AS (
  -- Turn the question into an OR query of its stemmed, stop-word-free terms:
  -- "How many layers does the encoder have?" -> 'mani' | 'layer' | 'encod'.
  -- quote_literal() makes every term safe, whatever punctuation the user typed.
  SELECT to_tsquery('simple', coalesce(string_agg(quote_literal(lex), ' | '), '')) AS tsq
    FROM unnest(tsvector_to_array(to_tsvector('english', $4))) AS lex
),
vec AS (
  SELECT id, 1 - dist AS similarity, row_number() OVER (ORDER BY dist) AS rnk
    FROM (
      SELECT id, embedding <=> $1::vector AS dist
        FROM chunks
       WHERE user_id = $2 AND ($3::uuid[] IS NULL OR document_id = ANY($3::uuid[]))
       ORDER BY embedding <=> $1::vector
       LIMIT $5
    ) nearest
),
kw AS (
  SELECT id, row_number() OVER (ORDER BY rank DESC) AS rnk
    FROM (
      SELECT c.id, ts_rank_cd(c.tsv, q.tsq) AS rank
        FROM chunks c, q
       WHERE c.user_id = $2 AND ($3::uuid[] IS NULL OR c.document_id = ANY($3::uuid[]))
         AND c.tsv @@ q.tsq
       ORDER BY rank DESC
       LIMIT $5
    ) matches
),
fused AS (
  SELECT coalesce(vec.id, kw.id) AS id,
         vec.rnk AS vector_rank, kw.rnk AS keyword_rank, vec.similarity,
         coalesce(1.0 / (${RRF_K} + vec.rnk), 0) + coalesce(1.0 / (${RRF_K} + kw.rnk), 0) AS score
    FROM vec FULL OUTER JOIN kw ON vec.id = kw.id
)
SELECT f.id::text, c.document_id AS "documentId", d.title AS "documentTitle", c.ordinal,
       c.page_start AS "pageStart", c.page_end AS "pageEnd", c.heading, c.content,
       f.score::float8 AS score, f.vector_rank::int AS "vectorRank", f.keyword_rank::int AS "keywordRank",
       f.similarity::float8 AS similarity
  FROM fused f
  JOIN chunks c ON c.id = f.id
  JOIN documents d ON d.id = c.document_id
 ORDER BY f.score DESC, f.vector_rank NULLS LAST
 LIMIT $6`;

export async function hybridSearch(db: Db, embedder: Embedder, opts: SearchOptions): Promise<SearchResult> {
  const t0 = performance.now();
  const queryVector = await embedder.embedQuery(opts.query);
  const t1 = performance.now();

  const { rows } = await db.query<RetrievedChunk>(HYBRID_SQL, [
    toPgVector(queryVector),
    opts.userId,
    opts.documentIds?.length ? opts.documentIds : null,
    opts.query,
    opts.candidates ?? 40,
    opts.limit ?? 8,
  ]);
  const t2 = performance.now();

  return {
    chunks: rows,
    topSimilarity: Math.max(0, ...rows.map((r) => r.similarity ?? 0)),
    timings: { embedMs: Math.round(t1 - t0), searchMs: Math.round(t2 - t1) },
  };
}
