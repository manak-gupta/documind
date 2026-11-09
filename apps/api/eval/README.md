# Evaluation

How DocuMind's retrieval and answer quality is measured. All numbers in the main README come from
`results/*.json`, produced by the scripts in this folder.

## Dataset: `dataset.jsonl` (40 questions, committed)

Over 4 public PDFs (`docs.json`): *Attention Is All You Need*, *BERT*, *Retrieval-Augmented
Generation*, and the *NIST AI Risk Management Framework 1.0* (15–48 pages each; ML papers and a
government standard, so the content isn't all one style).

| Type | Count | How it was made |
|---|---|---|
| Synthetic | 26 | `generate.ts` splits each document into 7 equal slices, takes a passage from each, and has an LLM write one factual question plus a short answer. Gold pages = that passage's pages. |
| Hand-written | 8 | Written by hand; every gold page number was checked against the parsed PDF text. |
| Unanswerable | 6 | Not answerable from any document. 3 are obviously off-topic; 3 are near-topic (e.g. *"How much did it cost in US dollars to train the big Transformer?"*: the paper gives FLOPs, not dollars). |

After generation the set was reviewed by hand: duplicate questions were merged (their gold pages
combined), and hand-written questions that overlapped generated ones were replaced.
The dataset is generated once and committed, so every run asks exactly the same questions.

## Metrics

**Retrieval** (34 answerable questions, top 8 chunks, exactly what the LLM would receive):
- **Recall@k**: share of questions where a chunk from the right document whose page range
  includes a gold page appears in the top k.
- **MRR**: mean of 1/rank of the first correct chunk (rewards ranking it first).

**Answers** (all 40 questions, the same `answerQuestion()` code path the app uses):
- **Accuracy**: an LLM judge compares each answer with the reference answer: correct = 1,
  partial = 0.5, incorrect = 0. Declining an answerable question counts as incorrect.
- **Refusal accuracy**: unanswerable questions correctly declined.
- **Citation precision**: share of verified citations that point at a gold page.
- **Latency**: p50/p95 time to first token and total time, measured on the free tier.

## Running it
```bash
npm run eval -w @documind/api -- --chunk-size 400                          # retrieval: all modes
npm run eval -w @documind/api -- --chunk-size 400 --reuse-index --modes hybrid --keyword-weights 1,0.5,0.25
npm run eval -w @documind/api -- --chunk-size 400 --reuse-index --answers --thinking off
```
Each chunking config is indexed under its own eval account (`eval-c400-o60@documind.eval`, etc.)
with the real ingestion pipeline. `--reuse-index` skips re-embedding (the free tier allows
100 embedding requests per minute, so indexing all four PDFs at 200 tokens takes about 7 minutes).

## Limitations (read before quoting the numbers)
- **Small sample.** 34 answerable questions: one question moves a percentage by about 3 points. Treat
  differences under about 6 points as noise.
- **Page-level gold labels favour bigger chunks.** A larger chunk spans more pages, so it's more
  likely to overlap a gold page. That's why chunk size is decided on *answer* accuracy and token
  cost, not retrieval recall alone.
- **Synthetic questions come from single passages**, which slightly favours retrieval at the
  chunk size they were generated with (400). Hand-written questions offset this.
- **LLM judge.** Verdicts were spot-checked by hand, but a judge can be wrong in either direction.
- **Free-tier latency** varies with load and includes rate-limit waits; paid tiers are faster.
