// The full evaluation in one command:  npm run eval:all -w @documind/api
//
// 1. 400-token chunks: index, then retrieval for every mode + an RRF keyword-weight sweep
// 2. pick the keyword weight with the best MRR (ties -> better Recall@3)
// 3. answers with that weight, thinking off and thinking low
// 4. 800-token chunks: index + retrieval (the 200-token run is already recorded)
//
// Each step reuses whatever is already indexed, so it can be re-run after a quota interruption.
// Note: the weight is tuned and reported on the same 34 questions (small set, see README).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_DIR } from './shared.ts';

const run = (args: string[]) => {
  console.log(`\n$ eval ${args.join(' ')}`);
  const r = spawnSync(process.execPath, ['--env-file-if-exists=../../.env', 'eval/run.ts', ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`Step failed (exit ${r.status}). Fix or wait for quota, then re-run: completed indexes are reused.`);
    process.exit(r.status ?? 1);
  }
};

const WEIGHTS = [1, 0.75, 0.5, 0.25];
run(['--chunk-size', '400', '--reuse-index', '--keyword-weights', WEIGHTS.join(','), '--name', 'c400-retrieval']);

const sweep = JSON.parse(readFileSync(join(EVAL_DIR, 'results', 'c400-retrieval.json'), 'utf8')) as {
  retrieval: Record<string, { mrr: number; recall3: number }>;
};
const best = WEIGHTS
  .map((w) => ({ w, m: sweep.retrieval[w === 1 ? 'hybrid' : `hybrid-kw${w}`]! }))
  .sort((a, b) => b.m.mrr - a.m.mrr || b.m.recall3 - a.m.recall3)[0]!;
console.log(`\nBest keyword weight: ${best.w} (MRR ${best.m.mrr.toFixed(3)}, R@3 ${(best.m.recall3 * 100).toFixed(1)}%)`);

for (const thinking of ['off', 'low']) {
  run(['--chunk-size', '400', '--reuse-index', '--modes', 'hybrid', '--keyword-weights', String(best.w),
    '--answers', '--thinking', thinking, '--answer-keyword-weight', String(best.w),
    '--name', `c400-answers-thinking-${thinking}`]);
}

run(['--chunk-size', '800', '--reuse-index', '--keyword-weights', `1,${best.w}`, '--name', 'c800-retrieval']);
console.log('\nDone. Results in eval/results/.');
