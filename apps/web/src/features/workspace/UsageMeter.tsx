import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { api } from '../../lib/api.ts';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

// Today's token use against the per-user budget, plus typical answer speed.
// Refreshed after every question (useAsk invalidates the "usage" query).
export function UsageMeter() {
  const { data } = useQuery({ queryKey: ['usage'], queryFn: api.usage, staleTime: 60_000 });
  if (!data || data.questions7d === 0) return null;

  const pct = Math.min(100, Math.round((data.tokensToday / data.dailyTokenBudget) * 100));
  return (
    <div className="space-y-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800"
      title={`Last 7 days: ${data.questions7d} questions · cache hits ${data.cacheHitPct ?? 0}% · retrieval p50 ${data.retrievalP50 ?? '–'} ms · first token p95 ${data.ttftP95 ?? '–'} ms`}>
      <div className="flex items-center gap-1.5 text-zinc-500">
        <Activity className="size-3.5" />
        <span>Today</span>
        <span className="ml-auto tabular-nums">{compact.format(data.tokensToday)} / {compact.format(data.dailyTokenBudget)} tokens</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className={`h-full rounded-full ${pct > 85 ? 'bg-amber-500' : 'bg-brand-500'}`} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <div className="flex justify-between text-zinc-400">
        <span>{data.questionsToday} questions</span>
        {data.totalP50 != null && <span>~{(data.totalP50 / 1000).toFixed(1)} s per answer</span>}
      </div>
    </div>
  );
}
