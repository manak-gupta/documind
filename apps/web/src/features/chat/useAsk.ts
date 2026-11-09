import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnswerResult, TraceChunk } from '../../lib/api.ts';
import { readSse } from '../../lib/sse.ts';

export interface LiveAnswer {
  question: string;
  stage: 'rewriting' | 'retrieving' | 'generating' | 'done' | 'error';
  text: string;                 // streamed so far
  searchQuery?: string;
  topSimilarity?: number;
  sources: TraceChunk[];
  result?: AnswerResult;
  error?: string;
}

// Streams one answer. Kept in local state while it's in flight; once done, the conversation
// query is refetched so the stored message replaces the live one.
export function useAsk(conversationId: string | undefined) {
  const [live, setLive] = useState<LiveAnswer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  const ask = useCallback(async (question: string, documentIds: string[], convId = conversationId) => {
    if (!convId) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setLive({ question, stage: 'retrieving', text: '', sources: [] });
    const patch = (p: Partial<LiveAnswer>) => setLive((l) => (l ? { ...l, ...p } : l));

    try {
      const res = await fetch(`/api/conversations/${convId}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, documentIds: documentIds.length ? documentIds : undefined }),
        signal: abort.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        patch({ stage: 'error', error: body.message ?? `Request failed (${res.status})` });
        return;
      }

      for await (const { event, data } of readSse(res)) {
        const d = data as Record<string, unknown>;
        if (event === 'status') patch({ stage: d.stage as LiveAnswer['stage'] });
        else if (event === 'sources') patch({ sources: d.chunks as TraceChunk[], searchQuery: d.searchQuery as string, topSimilarity: d.topSimilarity as number });
        else if (event === 'token') setLive((l) => (l ? { ...l, text: l.text + (d.text as string) } : l));
        else if (event === 'error') patch({ stage: 'error', error: d.message as string });
        else if (event === 'done') patch({ stage: 'done', result: d as unknown as AnswerResult, text: (d as unknown as AnswerResult).answer });
      }
    } catch (err) {
      if (!abort.signal.aborted) patch({ stage: 'error', error: 'Connection lost while answering. Please try again.' });
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['conversation', convId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['usage'] });
    }
  }, [conversationId, queryClient]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const clear = useCallback(() => setLive(null), []);
  return { live, ask, stop, clear };
}
