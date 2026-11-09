// Builds eval/dataset.jsonl: 28 synthetic + 6 hand-written + 6 unanswerable questions.
//   npm run eval:generate     (needs GEMINI_API_KEY; run once, then the dataset is committed)
//
// Synthetic questions: passages are sampled evenly through each document, and a model writes one
// factual question per passage. The passage's pages become the ground truth, so retrieval can be
// scored automatically. The dataset is generated ONCE and committed: every eval run uses exactly
// the same questions, so scores are comparable across changes.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkPages } from '../src/ingestion/chunk.ts';
import { parsePdf } from '../src/ingestion/parse.ts';
import { EVAL_DIR, type EvalItem, fetchDoc, geminiJson, loadDocs, sleep } from './shared.ts';

const PER_DOC = 7;
if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
const apiKey: string = process.env.GEMINI_API_KEY;
const model = process.env.LLM_FAST_MODEL ?? 'gemini-3.5-flash-lite';

// Written by hand from the Attention paper (pages are 1-based PDF pages).
// Written by hand (pages are 1-based PDF pages). Chosen not to duplicate the synthetic ones.
const MANUAL: Omit<EvalItem, 'id' | 'type'>[] = [
  { doc: 'attention', pages: [3], question: 'How many identical layers are in the Transformer encoder stack?', answer: 'N = 6 identical layers.' },
  { doc: 'attention', pages: [5], question: 'What is the dimensionality of the inner layer of the position-wise feed-forward networks?', answer: 'd_ff = 2048.' },
  { doc: 'attention', pages: [8], question: 'What dropout rate was used for the base Transformer model?', answer: 'P_drop = 0.1.' },
  { doc: 'attention', pages: [7, 8], question: 'How long did it take to train the big Transformer models?', answer: '3.5 days (300,000 steps) on 8 P100 GPUs.' },
  { doc: 'attention', pages: [7], question: 'Which optimizer and hyperparameters were used to train the Transformer?', answer: 'Adam with beta1 = 0.9, beta2 = 0.98 and epsilon = 1e-9, with a warmup learning-rate schedule.' },
  { doc: 'attention', pages: [8], question: 'What value of label smoothing was used during training?', answer: 'epsilon_ls = 0.1.' },
  { doc: 'bert', pages: [4], question: 'What are the two unsupervised tasks used to pre-train BERT?', answer: 'Masked LM (MLM) and Next Sentence Prediction (NSP).' },
  { doc: 'bert', pages: [5, 14], question: 'What corpora was BERT pre-trained on, and how large were they?', answer: 'BooksCorpus (800M words) and English Wikipedia (2,500M words).' },
];
// Every hand-written page number was checked against the parsed PDF text.
// After generation the dataset was reviewed by hand: questions asking the same thing were
// merged into one item whose gold pages include every page that answers it.

// Not answerable from any of the documents. Some are obviously off-topic (should be declined
// before calling the LLM); others are close to the papers' subject (the LLM itself must decline).
const UNANSWERABLE = [
  'What is the population of Paris?',
  'Who won the 2022 FIFA World Cup?',
  'How many parameters does GPT-4 have?',
  'How much did it cost in US dollars to train the big Transformer model?',
  'What accuracy does the RAG model achieve on ImageNet?',
  'What is the boiling point of water at sea level in Fahrenheit?',
];

const SCHEMA = {
  type: 'object',
  properties: {
    skip: { type: 'boolean', description: 'true if the passage contains no clear, specific fact worth asking about' },
    question: { type: 'string' },
    answer: { type: 'string' },
  },
  required: ['skip'],
};

const items: EvalItem[] = [];

for (const doc of await loadDocs()) {
  const parsed = await parsePdf(new Uint8Array(await readFile(await fetchDoc(doc))));
  const eligible = chunkPages(parsed.pages).filter((c) =>
    c.tokenCount >= 150 && !/reference|bibliograph|acknowledg|appendix/i.test(c.heading ?? ''));
  console.log(`${doc.id}: ${parsed.pageCount} pages, ${eligible.length} eligible passages`);

  // One question per equal slice of the document (beginning, middle, end all covered).
  // If a slice's middle passage is skipped, try its neighbours within the same slice.
  let made = 0;
  for (let slice = 0; slice < PER_DOC; slice++) {
    const from = Math.floor((slice * eligible.length) / PER_DOC);
    const to = Math.floor(((slice + 1) * eligible.length) / PER_DOC);
    const mid = Math.floor((from + to) / 2);
    const order = Array.from({ length: to - from }, (_, i) => from + i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    for (const index of order.slice(0, 3)) {
      if (await tryPassage(doc, eligible[index]!, made)) {
        made++;
        break;
      }
    }
  }
}

async function tryPassage(doc: { id: string; title: string }, chunk: ReturnType<typeof chunkPages>[number], made: number): Promise<boolean> {
  {
    const out = await geminiJson<{ skip: boolean; question?: string; answer?: string }>({
      apiKey, model, schema: SCHEMA,
      prompt: `You are writing an evaluation set for a document question-answering system.
Below is a passage from the document "${doc.title}".
Write ONE specific factual question that this passage answers clearly, plus its short answer (one sentence).
Rules:
- A reader of the whole document must be able to ask it without seeing the passage: never say "this passage" or "the text".
- Prefer concrete facts: numbers, names, definitions, methods, results.
- No questions about citations, reference numbers, author names, affiliations, or figure/table numbers.
- If the passage has no clear fact worth asking about, return {"skip": true}.

Passage (pages ${chunk.pageStart}-${chunk.pageEnd}):
"""${chunk.content}"""`,
    });
    await sleep(1_500); // stay well inside free-tier rate limits
    if (out.skip || !out.question || !out.answer) return false;
    if (items.some((i) => i.question === out.question)) return false;
    const pages = Array.from({ length: chunk.pageEnd - chunk.pageStart + 1 }, (_, i) => chunk.pageStart + i);
    items.push({ id: `${doc.id}-s${made + 1}`, type: 'synthetic', doc: doc.id, pages, question: out.question, answer: out.answer });
    console.log(`  + p${chunk.pageStart}-${chunk.pageEnd}: ${out.question}`);
    return true;
  }
}

MANUAL.forEach((m, i) => items.push({ id: `manual-${i + 1}`, type: 'manual', ...m }));
UNANSWERABLE.forEach((q, i) => items.push({ id: `none-${i + 1}`, type: 'unanswerable', doc: null, pages: [], question: q, answer: '' }));

await writeFile(join(EVAL_DIR, 'dataset.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
console.log(`\nWrote ${items.length} questions to eval/dataset.jsonl`);
