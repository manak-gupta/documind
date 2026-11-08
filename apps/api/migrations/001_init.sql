-- 001_init: core schema. Runs inside one transaction (see src/db/migrate.ts).

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: the vector type + HNSW index
CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive text, for emails

-- ---------- auth ----------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,          -- "A@x.com" and "a@x.com" are the same user
  password_hash text NOT NULL,                   -- argon2id hash, never the password
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id         text PRIMARY KEY,                   -- SHA-256 of the cookie token, so a DB leak doesn't leak live sessions
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------- documents & chunks ----------
CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  filename      text NOT NULL,
  sha256        text NOT NULL,
  size_bytes    integer NOT NULL,
  page_count    integer,                         -- known only after parsing
  scanned_pages integer NOT NULL DEFAULT 0,      -- pages with no text layer (we don't OCR)
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  error         text,
  storage_key   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)                       -- same file uploaded twice = no re-embedding
);
CREATE INDEX documents_user_created_idx ON documents (user_id, created_at DESC);

CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,                     -- denormalized so search can filter without a join
  ordinal     integer NOT NULL,                  -- position within the document
  page_start  integer NOT NULL,
  page_end    integer NOT NULL,
  heading     text,
  content     text NOT NULL,
  token_count integer NOT NULL,
  embedding   vector(768) NOT NULL,              -- must equal EMBEDDING_DIM
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (document_id, ordinal)
);
-- Approximate nearest-neighbour index for cosine distance (the <=> operator).
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);
-- Inverted index for full-text search (the @@ operator).
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_user_doc_idx ON chunks (user_id, document_id);

-- ---------- background jobs (Postgres as the queue) ----------
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after    timestamptz NOT NULL DEFAULT now(),   -- pushed into the future for retry backoff
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Partial index: the worker only ever looks for queued jobs, so only those are indexed.
CREATE INDEX jobs_pick_idx ON jobs (run_after) WHERE status = 'queued';

-- ---------- chat ----------
CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT 'New conversation',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations (user_id, created_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  citations       jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

-- ---------- observability & caching ----------
CREATE TABLE query_logs (
  id                 bigserial PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id         uuid REFERENCES messages(id) ON DELETE SET NULL,
  rewritten_query    text,
  retrieval_ms       integer,
  ttft_ms            integer,                    -- time to first token
  total_ms           integer,
  input_tokens       integer,
  output_tokens      integer,
  cost_usd           numeric(10, 6) NOT NULL DEFAULT 0,
  provider           text,
  model              text,
  citations_rejected integer NOT NULL DEFAULT 0,
  cache_hit          boolean NOT NULL DEFAULT false,
  chunk_ids          bigint[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX query_logs_user_created_idx ON query_logs (user_id, created_at DESC);

CREATE TABLE answer_cache (
  key        text PRIMARY KEY,                   -- hash(question + doc ids + doc versions)
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
