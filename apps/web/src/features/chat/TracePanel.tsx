import { useState } from 'react';
import { ChevronRight, Gauge } from 'lucide-react';
import type { AnswerResult, TraceChunk } from '../../lib/api.ts';

interface Props {
  sources: TraceChunk[];
  searchQuery?: string;
  question: string;
  topSimilarity?: number;
  result?: AnswerResult;
  onOpen: (chunk: TraceChunk) => void;
}

// "Why this answer?": what was retrieved and how it ranked under each method, plus where the
// time and tokens went. Makes the RAG pipeline inspectable instead of a black box.
export function TracePanel({ sources, searchQuery, question, topSimilarity, result, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  if (!sources.length && !result) return null;
  const cited = new Set(result?.citations.map((c) => c.n));
  const t = result?.timings;

  return (
    <div className="rounded-xl border border-zinc-200 text-sm dark:border-zinc-800">
      <button type="button" onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900">
        <ChevronRight className={`size-3.5 transition ${open ? 'rotate-90' : ''}`} />
        <Gauge className="size-3.5" /> Why this answer?
        {t && <span className="ml-auto font-normal text-zinc-400">{(t.totalMs / 1000).toFixed(1)} s · {sources.length} sources</span>}
      </button>

      {open && (
        <div className="space-y-3 border-t border-zinc-200 p-3 dark:border-zinc-800">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            {t && <Stat label="Retrieval" value={`${t.retrievalMs} ms`} />}
            {t && <Stat label="First token" value={t.ttftMs != null ? `${t.ttftMs} ms` : 'n/a'} />}
            {result?.usage && <Stat label="Tokens in / out" value={`${result.usage.inputTokens} / ${result.usage.outputTokens}`} />}
            {topSimilarity != null && <Stat label="Best match" value={topSimilarity.toFixed(3)} />}
            {result && <Stat label="Citations rejected" value={String(result.rejectedCitations)} />}
            {t && t.rewriteMs > 50 && <Stat label="Rewrite" value={`${t.rewriteMs} ms`} />}
          </dl>
          {searchQuery && searchQuery !== question && (
            <p className="text-xs text-zinc-500">Searched for: <span className="italic">“{searchQuery}”</span></p>
          )}
          <ol className="space-y-1.5">
            {sources.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onOpen(s)}
                  className={`w-full rounded-lg border px-2.5 py-2 text-left transition hover:border-brand-400 ${
                    cited.has(s.n) ? 'border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-zinc-200 dark:border-zinc-800'}`}>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-brand-700 dark:text-brand-300">[{s.n}]</span>
                    <span className="truncate font-medium">{s.documentTitle}</span>
                    <span className="text-zinc-400">p. {s.pageStart}{s.pageEnd !== s.pageStart && `–${s.pageEnd}`}</span>
                    <span className="ml-auto flex shrink-0 gap-1 font-mono text-[10px]">
                      <Rank label="vec" rank={s.vectorRank} />
                      <Rank label="kw" rank={s.keywordRank} />
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{s.preview}</p>
                </button>
              </li>
            ))}
          </ol>
          <p className="text-[11px] text-zinc-400">
            Ranks from vector (meaning) and keyword search, merged with Reciprocal Rank Fusion. Highlighted sources are cited in the answer.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-zinc-400">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Rank({ label, rank }: { label: string; rank: number | null }) {
  return (
    <span className={`rounded px-1 py-0.5 ${rank ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' : 'text-zinc-300 dark:text-zinc-700'}`}>
      {label} {rank ?? '–'}
    </span>
  );
}
