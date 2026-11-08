# DocuMind

Ask questions across your PDFs and get answers cited to **document → page → exact passage**.
Click a citation and the PDF opens at the highlighted passage.

> 🚧 Work in progress. Live demo, screenshots and eval scores coming.

**Stack:** React · Node.js (Fastify, TypeScript) · PostgreSQL + pgvector · Claude API · Voyage embeddings · Docker · AWS EC2 · Cloudflare

## Highlights
- Hybrid retrieval: vector + full-text search fused with Reciprocal Rank Fusion, in a single SQL query
- Native, verifiable citations, plus a "Why this answer?" trace panel
- Background ingestion on a Postgres job queue (`FOR UPDATE SKIP LOCKED`) with live progress over SSE
- Measured quality: a 40-question eval set with recall, answer accuracy and citation precision
- Under $0.001 per question, with per-user budgets and an answer cache

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the reasoning behind each decision.

## Run locally
```bash
cp .env.example .env      # add API keys
npm run db:up             # Postgres + pgvector in Docker
```
More steps will be added as the app is built.
