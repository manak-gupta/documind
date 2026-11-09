import { useState } from 'react';
import { ChevronRight, Gauge } from 'lucide-react';
import type { MessageTrace, TraceChunk } from '../../lib/api.ts';

interface Props {
  trace: MessageTrace;
  question: string;
  citedNs: number[];
  onOpen: (chunk: TraceChunk) => void;
}

// "Why this answer?": what was retrieved and how it ranked under each method, plus where the
// time and tokens went. Makes the RAG pipeline inspectable instead of a black box.
export function TracePanel({ trace, question, citedNs, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  if (!trace.chunks.length && !trace.timings) return null;
  const cited = new Set(citedNs);
  const t = trace.timings;

  return (
    <div className="rounded-xl border border-zinc-200 text-sm dark:border-zinc-800">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:text-muted dark:hover:bg-zinc-900">
        <ChevronRight className={`size-3.5 transition ${open ? 'rotate-90' : ''}`} />
        <Gauge className="size-3.5" /> Why this answer?
        {trace.cacheHit && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            cached · 0 tokens
          </span>
        )}
        <span className="ml-auto font-normal text-muted">
          {t && !trace.cacheHit ? `${(t.totalMs / 1000).toFixed(1)} s · ` : ''}{trace.chunks.length} sources
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-zinc-200 p-3 dark:border-zinc-800">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
            {t && <Stat label="Retrieval" value={`${t.retrievalMs} ms`} />}
            {t && <Stat label="First token" value={t.ttftMs != null ? `${(t.ttftMs / 1000).toFixed(1)} s` : 'no LLM call'} />}
            {trace.usage && <Stat label="Tokens in / out" value={`${trace.usage.inputTokens.toLocaleString()} / ${trace.usage.outputTokens.toLocaleString()}`} />}
            {trace.topSimilarity != null && <Stat label="Best match" value={trace.topSimilarity.toFixed(3)} />}
            {trace.rejectedCitations != null && <Stat label="Citations rejected" value={String(trace.rejectedCitations)} />}
            {t && t.rewriteMs > 50 && <Stat label="Follow-up rewrite" value={`${t.rewriteMs} ms`} />}
          </dl>
          {trace.searchQuery && trace.searchQuery !== question && (
            <p className="text-xs text-zinc-500">Searched for: <span className="italic">“{trace.searchQuery}”</span></p>
          )}
          <ol className="space-y-1.5">
            {trace.chunks.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onOpen(s)}
                  className={`w-full rounded-lg border px-2.5 py-2 text-left transition hover:border-brand-400 ${
                    cited.has(s.n) ? 'border-brand-300 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-zinc-200 dark:border-zinc-800'}`}>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-brand-700 dark:text-brand-300">[{s.n}]</span>
                    <span className="truncate font-medium">{s.documentTitle}</span>
                    <span className="shrink-0 text-muted">p. {s.pageStart}{s.pageEnd !== s.pageStart && `–${s.pageEnd}`}</span>
                    <span className="ml-auto flex shrink-0 gap-1 font-mono text-[10px]">
                      <Rank label="vec" rank={s.vectorRank} />
                      <Rank label="kw" rank={s.keywordRank} />
                    </span>
                  </div>
                  {s.heading && <p className="mt-0.5 truncate text-[11px] text-muted">§ {s.heading}</p>}
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{s.preview}</p>
                </button>
              </li>
            ))}
          </ol>
          <p className="text-[11px] text-muted">
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
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Rank({ label, rank }: { label: string; rank: number | null }) {
  return (
    <span className={`rounded px-1 py-0.5 ${rank ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' : 'text-muted'}`}>
      {label} {rank ?? '–'}
    </span>
  );
}
