# DocuMind interview guide

How to talk about this project: the 60-second pitch, then the questions interviewers ask, each
with a short spoken answer and where to find it in the code. Measured numbers are in the
README's Evaluation section; quote them, as they're the strongest proof the system works.

---

## The 60-second pitch

> "DocuMind is a RAG application: you upload PDFs, ask questions across all of them, and every
> claim in the answer is cited to the document, page and exact passage. Click a citation and the
> PDF opens at that page with the passage highlighted.
>
> Three things I'm proud of. First, **hybrid retrieval** in a single Postgres query: pgvector
> similarity plus full-text search, fused with Reciprocal Rank Fusion. Second, **citations are
> verified on the server**: the model has to quote its source, and any quote that isn't actually
> in the cited chunk is removed before the user sees it. Third, it's **measured**: a 40-question
> evaluation set with retrieval recall, LLM-judged answer accuracy and citation precision, which
> I used to choose chunk size and retrieval weights instead of guessing.
>
> It's production-shaped: background ingestion on a Postgres job queue, streaming over SSE,
> answer caching, per-user rate limits and budgets, Docker, CI, and Caddy with HTTPS."

---

## Architecture

**Q: Walk me through what happens when I upload a PDF.**
The API checks the file's bytes (it must start with `%PDF-`, regardless of name), streams it to
disk while computing a SHA-256, and inserts the document row *and* an ingest job in one SQL
statement, so they can't get out of sync. It returns 202 immediately. A separate worker process
claims the job, parses each page with pdf.js, chunks the text, embeds the chunks in rate-limited
batches, and writes every chunk in one transaction. Each stage change is a `pg_notify`, which the
API forwards to the browser over SSE, so the progress bar moves live.
→ `documents/routes.ts`, `ingestion/pipeline.ts`, `jobs/runner.ts`

**Q: Why a separate worker process?**
PDF parsing is CPU-heavy, and embedding is slow network I/O. In the API process it would block the
event loop and slow every other request. Separate processes also scale separately: more workers
for upload-heavy load, more API instances for read load.

**Q: Why use Postgres as the job queue instead of Redis/BullMQ?**
One fewer service to run. The job is created in the *same transaction* as the document row, so
there's no window where a document exists without its job. `FOR UPDATE SKIP LOCKED` lets several
workers pull jobs concurrently without ever taking the same one (a test runs 10 concurrent
claimers against 5 jobs). Ingestion is a few jobs a minute, nowhere near Postgres's limits.
At thousands of jobs a second I'd move to a dedicated queue.
→ `jobs/queue.ts`, `jobs/queue.test.ts`

**Q: How does the worker find new jobs quickly without hammering the database?**
A trigger runs `pg_notify('jobs')` on every insert, and the worker `LISTEN`s, so it wakes up
immediately. Polling every 5 s remains as a fallback, because a NOTIFY sent while no worker is
connected is lost.

**Q: What if the worker crashes mid-job?**
The job stays `running` with a `locked_at` time. On startup, workers requeue jobs that have been
running too long. Ingestion is idempotent: it deletes any chunks from the failed attempt before
inserting, so a retry never duplicates. Failures retry with exponential backoff (10 s, 20 s,
40 s). Permanent failures, such as a scanned PDF with no text, fail once with a helpful message
instead of retrying pointlessly.

---

## Retrieval

**Q: How did you chunk documents, and why that size?**
By sentences (`Intl.Segmenter`), packed to about 400 tokens with about 60 tokens of overlap, so a
chunk never cuts a sentence and a fact spanning a boundary appears whole in at least one chunk.
Headings (detected by font size) start a new chunk and label every chunk under them. Tiny fragments
like figure labels are merged into neighbours; I found those on a real paper, where they were
4-token chunks polluting results. The size was **chosen by the eval**: I compared 200, 400 and 800
tokens (see README).
→ `ingestion/chunk.ts`

**Q: What's the "contextual header"?**
Before embedding, each chunk is prefixed with "Document title › Section". "Revenue grew 12%" alone
is ambiguous; with the header, the embedding knows whose revenue, in which section. It's cheap and
improves retrieval for chunks that rely on context.

**Q: Explain hybrid search and RRF.**
Vector search finds meaning ("staff turnover" matches "employee attrition") but can miss exact
tokens like model names or numbers. Full-text search is the opposite. I run both in one SQL query
(HNSW index for vectors, GIN index for tsvector), then fuse the two **rankings** with Reciprocal
Rank Fusion: score = Σ 1/(60 + rank). I fuse ranks, not raw scores, because cosine similarity and
ts_rank are on incomparable scales. A chunk ranked well by both methods wins.
→ `retrieval/hybrid.ts`

**Q: Did hybrid actually help?**
Answer with the eval numbers. The honest story: at equal weights, hybrid improved Recall@3 but
*vector-only* was better at rank 1, because the keyword list pushed good semantic hits down.
So I made RRF weighted and swept the keyword weight on the eval set. That's the kind of decision
the eval exists for.

**Q: Your keyword search uses OR. Why not Postgres's `websearch_to_tsquery`?**
That ANDs every term. A natural question like "How many layers does the encoder have?" would need
"many" to appear in the passage. I build an OR query from the question's stemmed, stop-word-free
terms and let `ts_rank_cd` rank chunks matching more terms higher. Every term goes through
`quote_literal`, so user input can never become query syntax (there's a test with SQL-injection-style
input).

**Q: Why pgvector instead of Pinecone/Weaviate?**
Vectors, text, metadata and access control live in one database: a user filter is a `WHERE`,
deleting a document cascades to its vectors in the same transaction, and hybrid search is a single
query. No second system to keep in sync, and no extra bill. pgvector's HNSW handles millions of
vectors; a managed vector DB starts paying off at tens of millions, or with multi-region needs.

**Q: Any pitfalls with filtered vector search?**
Yes. HNSW returns its nearest candidates first and the `WHERE user_id = ...` filter applies after,
so with many users most candidates can be filtered out and recall silently drops. pgvector 0.8's
`hnsw.iterative_scan` keeps searching until enough rows pass the filter. It's set in migration 003.

---

## Generation and citations

**Q: How do you stop the model from making up citations?**
The model answers with [n] markers, then a delimiter, then one JSON line per cited source with a
**verbatim quote**. The server checks every quote against the chunk it cites: an exact match after
normalizing case, whitespace and quote marks, or ≥85% word overlap to tolerate PDF extraction
glitches. Wrong source numbers, invented quotes and paraphrases are removed before the answer is
shown, and counted in `query_logs.citations_rejected`. Tests cover each case.
→ `chat/citations.ts`, `chat/citations.test.ts`

**Q: How do you stream the answer but hide the citation JSON?**
A small state machine (`AnswerStreamSplitter`) shows text as it arrives, but holds back any tail
that could be the start of the delimiter, so a delimiter split across two network chunks never
flashes on screen. It also holds back the start while it could still be `NOT_FOUND`.
→ `chat/prompt.ts`

**Q: What if the documents don't contain the answer?**
Two layers. If the best retrieval similarity is below a threshold, we answer "not found" *without
calling the LLM*: cheaper, and nothing to hallucinate from. The threshold came from measurement:
off-topic questions scored about 0.54, real ones 0.78–0.84. Otherwise the prompt tells the model to
reply `NOT_FOUND` when the sources don't answer. The eval has 6 unanswerable questions, some
deliberately near the documents' topic.

**Q: Prompt injection: what if a PDF says "ignore your instructions"?**
Document text only enters inside delimited source tags, and the system prompt marks it as
untrusted. A document can't close its own tag (`</source` is defused). Most importantly, the model
has **no tools**: the worst a malicious PDF can do is distort the answer to its own question. It
can't trigger actions or read other users' data, because retrieval is filtered by user in SQL
before the model sees anything.

**Q: How do follow-up questions work?**
"What about the decoder?" retrieves nothing useful on its own, so a fast model rewrites it into a
standalone question using the recent conversation. The eval caught a real bug here: the lite model
rejects the "no thinking" setting I was sending, and my code silently fell back to the original
question. Now the rewrite step logs failures, and a regression test locks in the request shape.

**Q: Why Gemini? Isn't that vendor lock-in?**
The code depends on an `LlmProvider` interface and an `Embedder` interface; Gemini is one
implementation, and tests use fakes. Switching providers is a new class plus config. Gemini's free
tier made the project cost ₹0 to build and host. Its constraint is rate limits, so the embedder has
a sliding-window rate limiter matched to the quota (100 requests/minute, counted per text), and
retries honour Google's `retryDelay` hint.

---

## Backend engineering

**Q: How does auth work?**
Server-side sessions. Passwords are hashed with argon2id (built into Node 26) at OWASP settings.
The session cookie holds a random 256-bit token; the database stores only its SHA-256, so a leaked
sessions table can't be replayed. The cookie is httpOnly (no JS access, so XSS can't steal it),
Secure in production, and SameSite=Lax (blocks cross-site POSTs, i.e. CSRF). Logout deletes the
session server-side. Login gives an identical response for an unknown email and a wrong password,
and runs a dummy hash so response timing doesn't reveal which emails exist.
→ `auth/`

**Q: Why sessions instead of JWT?**
Instant revocation. A JWT is valid until it expires; revoking it needs a denylist, which is a
session table anyway. With one database lookup per request, there's nothing to gain from statelessness here.

**Q: How do you make sure one user can never see another's data?**
Every query filters by `user_id`, and another user's document returns 404, not 403, so its
existence isn't confirmed. Integration tests log in as two users and assert that search, files,
conversations and live events never cross over.

**Q: How do you protect cost and availability?**
Per-user rate limit (questions per minute) and daily token budget, computed from `query_logs` in
Postgres so they're correct across restarts and multiple instances. Per-IP rate limits on
login/register. An exact-match answer cache, keyed on user + normalized question + a "corpus
version". I deliberately avoided a *semantic* cache, because "revenue in 2022" and "revenue in
2023" embed almost identically and would serve the wrong answer. Uploading or deleting a document
changes the corpus version, so a stale answer can never be served.

**Q: Why SSE instead of WebSockets?**
The data only flows server → browser. SSE is plain HTTP: it works through proxies and Cloudflare,
browsers reconnect automatically, and it needs no extra protocol. I hit two real-world issues:
Cloudflare closes idle connections after 100 s, so the server sends a heartbeat every 15 s; and
Caddy's compression buffered the stream into one burst, so compression is now applied to static
files only. I found that by timing token arrival through the proxy.

**Q: What happens when the database goes down?**
`/health` returns 503 so the load balancer stops routing traffic; the process doesn't crash
(idle-client errors are handled), and it recovers on its own when Postgres returns. The API also
starts if the DB isn't up yet, and the live-event listener reconnects in the background. Tested by
stopping the database while the server was running.

**Q: How do migrations work?**
Plain numbered `.sql` files, each run in its own transaction and recorded in `schema_migrations`.
A Postgres advisory lock stops two processes (e.g. API and worker starting together) from
migrating at the same time. In production a one-shot `migrate` container runs before the API starts.

---

## Frontend

**Q: How is server state managed?**
TanStack Query for everything fetched (caching, refetching, optimistic delete). Live ingestion
events from `EventSource` are patched directly into the query cache, so every component showing
that document updates without polling.

**Q: How does the PDF highlight work?**
pdf.js (in a Web Worker) renders the cited page to a canvas. Its text layer gives positioned text
items; `findQuote` joins them into a normalized string while remembering each item's offsets, finds
the quote, and maps the match back to items. Their positions are transformed from PDF space
(origin bottom-left) into screen pixels to draw the highlight boxes. It falls back to the quote's
first or last words when PDF spacing differs. It's unit-tested, and those tests caught a bug with
curly quote marks.

**Q: Performance?**
pdf.js is the heaviest dependency, so the viewer is lazy-loaded in its own chunk and only downloads
when a citation is opened. Hashed assets are cached for a year; `index.html` is always revalidated,
so deploys appear instantly.

---

## Testing and quality

**Q: How did you test it?**
About 100 automated tests. Unit tests cover the chunker, citation verifier, stream splitter, retry
logic and rate limiter. Integration tests run against a real Postgres with pgvector (in CI as a
service container) for auth, uploads, the job queue, retrieval, ingestion end to end, chat, cache
and limits. External APIs are replaced by fakes (a deterministic hash-based embedder, a scripted
LLM), so tests are fast, free and offline. Playwright drives the real UI to capture screenshots.

**Q: How do you know the RAG quality is good?**
The eval set: 40 questions over 4 public PDFs (26 generated from sampled passages, 8 hand-written
with page numbers checked against the PDF text, 6 unanswerable). Retrieval is scored with
Recall@k and MRR on gold pages. Answers are graded by an LLM judge against reference answers, plus
citation precision, refusal accuracy and p50/p95 latency. The dataset is committed, so every
run asks exactly the same questions and scores are comparable.

**Q: Weaknesses of your eval?**
Be honest. 34 answerable questions is small (one question ≈ 3 points). Synthetic questions are
generated from single chunks, which slightly favours retrieval at the same chunk size, so I
included hand-written ones. The LLM judge can be wrong; I spot-checked its verdicts. Next steps:
a larger set and human labels.

**Q: What bugs did you find, and how?**
Good stories to tell:
1. Oversized uploads were silently truncated, not rejected (found by a test).
2. 4-token "noise" chunks from figure labels (found by ingesting a real paper).
3. Follow-up rewriting silently failing on one model (found by the eval).
4. The free-tier embedding quota counts per text, not per request (found by the eval, fixed with a rate limiter).
5. Compression buffering the SSE stream (found by timing tokens through Caddy).

---

## What I'd do next
- OCR for scanned PDFs (detection already exists; pages are counted as `scanned_pages`).
- A cross-encoder reranker on the top 20, if the eval shows headroom at rank 1.
- S3 for uploads and Redis-backed rate limits, to run several API instances.
- Teams and shared libraries, with Postgres row-level security as a second isolation layer.
