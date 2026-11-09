# DocuMind

Ask questions across your PDFs and get answers cited to **document → page → exact passage**.
Click a citation and the PDF opens at the highlighted passage.

> 🚧 Work in progress. Live demo, screenshots and eval scores coming.

**Stack:** React · Node.js (Fastify, TypeScript) · PostgreSQL + pgvector · Gemini API (provider-agnostic LLM layer) · Docker · AWS EC2 · Cloudflare

## Highlights
- Hybrid retrieval: vector + full-text search fused with Reciprocal Rank Fusion, in a single SQL query
- Citations verified on the server (every quote checked against its source), plus a "Why this answer?" trace panel
- Background ingestion on a Postgres job queue (`FOR UPDATE SKIP LOCKED`) with live progress over SSE
- Measured quality: a 40-question eval set with recall, answer accuracy and citation precision
- Swap LLM providers with one env var; runs at ₹0 on a free tier, with rate-limit-aware batching, caching and budgets

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the reasoning behind each decision.

## Run locally
Requires Node.js 24+ (runs TypeScript natively) and Docker.

```bash
cp .env.example .env      # add a free Gemini key from https://aistudio.google.com
npm install
npm run db:up             # Postgres 17 + pgvector in Docker
npm run migrate           # create the schema

# three terminals:
npm run dev:api           # API      http://localhost:4000
npm run dev:worker        # ingestion worker (parsing, chunking, embedding)
npm run dev:web           # web app  http://localhost:5173
```

```bash
npm test                  # API + web tests (needs the database running)
npm run typecheck
```
