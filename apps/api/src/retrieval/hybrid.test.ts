// Integration tests for hybrid retrieval (real Postgres + pgvector, fake embeddings).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { buildApp } from '../app.ts';
import { FakeEmbedder } from '../llm/embedder.ts';
import { createTestDb } from '../test/db.ts';
import { testConfig } from '../test/config.ts';
import { signUp } from '../test/http.ts';
import { seedDocument } from '../test/seed.ts';
import { hybridSearch } from './hybrid.ts';

describe('hybrid search', () => {
  let pool: pg.Pool;
  const embedder = new FakeEmbedder();

  before(async () => {
    pool = await createTestDb();
  });
  after(async () => {
    await pool.end();
  });

  const newUser = async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, `${id}@seed.dev`]);
    return id;
  };

  const paper = [
    'The encoder is composed of a stack of N = 6 identical layers.',
    'Each layer has two sub-layers: multi-head self-attention and a feed-forward network.',
    'We trained on the WMT 2014 English-German dataset of about 4.5 million sentence pairs.',
    'Dropout of 0.1 was applied to the output of each sub-layer before normalization.',
    'The Transformer achieves 28.4 BLEU on the English-to-German translation task.',
  ];

  test('a natural question with stop words still gets keyword matches (OR semantics)', async () => {
    const userId = await newUser();
    await seedDocument(pool, userId, 'Attention paper', paper);

    const { chunks } = await hybridSearch(pool, embedder, { userId, query: 'How many layers does the encoder have?' });
    const top = chunks[0]!;
    assert.match(top.content, /encoder is composed of a stack/);
    assert.ok(top.keywordRank !== null, 'matched by keyword search even though "many" is not in the text');
    assert.ok(top.vectorRank !== null);
  });

  test('a chunk found by both methods outranks one found by only one', async () => {
    const userId = await newUser();
    await seedDocument(pool, userId, 'Attention paper', paper);
    const { chunks } = await hybridSearch(pool, embedder, { userId, query: 'BLEU score on English German translation' });

    const both = chunks.filter((c) => c.vectorRank !== null && c.keywordRank !== null);
    const single = chunks.filter((c) => c.vectorRank === null || c.keywordRank === null);
    assert.ok(both.length > 0);
    if (single.length) assert.ok(Math.min(...both.map((c) => chunks.indexOf(c))) < Math.min(...single.map((c) => chunks.indexOf(c))));
    // Scores are sorted descending.
    assert.deepEqual(chunks.map((c) => c.score), [...chunks.map((c) => c.score)].sort((a, b) => b - a));
  });

  test("search never returns another user's chunks", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await seedDocument(pool, alice, 'Secret', ['The merger with Globex closes in March.']);
    await seedDocument(pool, bob, 'Bob notes', ['Groceries: milk, eggs, bread.']);

    const { chunks } = await hybridSearch(pool, embedder, { userId: bob, query: 'When does the Globex merger close?' });
    assert.ok(chunks.every((c) => !c.content.includes('Globex')));
  });

  test('documentIds restricts the search to the selected documents', async () => {
    const userId = await newUser();
    const a = await seedDocument(pool, userId, 'Doc A', ['Solar panels convert sunlight into electricity.']);
    await seedDocument(pool, userId, 'Doc B', ['Solar farms need large areas of land.']);

    const { chunks } = await hybridSearch(pool, embedder, { userId, query: 'solar', documentIds: [a] });
    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((c) => c.documentId === a));
  });

  test('limit is respected and results carry page, title and diagnostics', async () => {
    const userId = await newUser();
    await seedDocument(pool, userId, 'Attention paper', paper);
    const { chunks, topSimilarity, timings } = await hybridSearch(pool, embedder, { userId, query: 'layer', limit: 2 });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.documentTitle, 'Attention paper');
    assert.ok(chunks[0]!.pageStart >= 1);
    assert.ok(topSimilarity > 0 && topSimilarity <= 1);
    assert.ok(timings.searchMs >= 0);
  });

  test('hostile or odd input is treated as plain text, never as query syntax', async () => {
    const userId = await newUser();
    await seedDocument(pool, userId, 'Attention paper', paper);
    for (const query of [`'); DROP TABLE chunks; --`, 'C++ & SQL: what\'s "new" | !(x)', '???', '   the of and   ']) {
      await hybridSearch(pool, embedder, { userId, query }); // must not throw
    }
    assert.ok((await pool.query('SELECT 1 FROM chunks LIMIT 1')).rowCount === 1);
  });

  test('POST /search works over HTTP for the logged-in user', async () => {
    const app = await buildApp(testConfig(), { db: pool, embedder });
    const cookies = await signUp(app);
    const me = (await app.inject({ method: 'GET', url: '/me', cookies })).json().user;
    await seedDocument(pool, me.id, 'Attention paper', paper);

    const res = await app.inject({ method: 'POST', url: '/search', cookies, payload: { query: 'What dropout rate was used?' } });
    assert.equal(res.statusCode, 200);
    assert.match(res.json().chunks[0].content, /Dropout of 0.1/);
    assert.equal((await app.inject({ method: 'POST', url: '/search', payload: { query: 'x y' } })).statusCode, 401);
    await app.close();
  });
});
