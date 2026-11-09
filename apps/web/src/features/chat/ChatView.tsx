import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUp, FileQuestion, Search, Sparkles, Square } from 'lucide-react';
import { api, type Citation, type TraceChunk } from '../../lib/api.ts';
import { Spinner } from '../../components/Spinner.tsx';
import { AnswerText } from './AnswerText.tsx';
import { TracePanel } from './TracePanel.tsx';
import { type LiveAnswer, useAsk } from './useAsk.ts';

export interface SourceTarget {
  documentId: string;
  title: string;
  page: number;
  quote?: string;
}

interface Props {
  conversationId?: string;
  documentIds: string[];
  hasReadyDocuments: boolean;
  createConversation: () => Promise<string>;
  onOpenSource: (s: SourceTarget) => void;
}

const SUGGESTIONS = [
  'Summarize the key findings in a few bullet points.',
  'What methodology or approach was used?',
  'What are the main limitations mentioned?',
];

const STAGE_TEXT: Record<string, string> = {
  rewriting: 'Understanding your follow-up…',
  retrieving: 'Searching your documents…',
  generating: 'Writing a cited answer…',
};

export function ChatView({ conversationId, documentIds, hasReadyDocuments, createConversation, onOpenSource }: Props) {
  const { data, isPending } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.getConversation(conversationId!),
    enabled: !!conversationId,
  });
  const { live, ask, stop, clear } = useAsk(conversationId);
  const [draft, setDraft] = useState('');
  // Traces exist only for answers produced in this session (they come from the live stream).
  const [traces, setTraces] = useState<Record<string, LiveAnswer>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const messages = data?.messages ?? [];
  const busy = !!live && live.stage !== 'done' && live.stage !== 'error';

  // Once the stored message for a finished live answer has arrived, swap live -> stored.
  useEffect(() => {
    const id = live?.result?.messageId;
    if (id && messages.some((m) => m.id === id)) {
      setTraces((t) => ({ ...t, [id]: live }));
      clear();
    }
  }, [messages, live, clear]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, live?.text, live?.stage]);

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setDraft('');
    const id = conversationId ?? (await createConversation());
    void ask(q, documentIds, id);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  const openCitation = (c: Citation) => onOpenSource({ documentId: c.documentId, title: c.documentTitle, page: c.pageStart, quote: c.quote });
  const openChunk = (s: TraceChunk) => onOpenSource({ documentId: s.documentId, title: s.documentTitle, page: s.pageStart, quote: s.preview.slice(0, 160) });
  const empty = !messages.length && !live;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-8 sm:px-6">
          {conversationId && isPending && <div className="flex justify-center"><Spinner className="size-5 text-zinc-400" /></div>}

          {empty && !isPending && (
            <EmptyState hasDocuments={hasReadyDocuments} onPick={(s) => void send(s)} scoped={documentIds.length} />
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} text={m.content} />
            ) : (
              <AssistantBlock key={m.id}>
                <AnswerText text={m.content} citations={m.citations} onCite={openCitation} />
                <CitationList citations={m.citations} onOpen={openCitation} />
                {traces[m.id] && (
                  <TracePanel sources={traces[m.id]!.sources} searchQuery={traces[m.id]!.searchQuery} question={traces[m.id]!.question}
                    topSimilarity={traces[m.id]!.topSimilarity} result={traces[m.id]!.result} onOpen={openChunk} />
                )}
              </AssistantBlock>
            ),
          )}

          {live && !messages.some((m) => m.id === live.result?.messageId) && (
            <>
              <UserBubble text={live.question} />
              <AssistantBlock>
                {live.stage === 'error' ? (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">{live.error}</p>
                ) : live.text ? (
                  <AnswerText text={live.text} citations={live.result?.citations ?? []} streaming={busy} onCite={openCitation} />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-zinc-500">
                    <Spinner className="size-4 text-brand-500" /> {STAGE_TEXT[live.stage] ?? 'Working…'}
                  </p>
                )}
                {live.result && <CitationList citations={live.result.citations} onOpen={openCitation} />}
                {(live.sources.length > 0 || live.result) && (
                  <TracePanel sources={live.sources} searchQuery={live.searchQuery} question={live.question}
                    topSimilarity={live.topSimilarity} result={live.result} onOpen={openChunk} />
                )}
              </AssistantBlock>
            </>
          )}
          <div ref={bottom} />
        </div>
      </div>

      <form onSubmit={onSubmit} className="border-t border-zinc-200 bg-white/80 p-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-zinc-300 bg-white p-2 shadow-sm focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/10 dark:border-zinc-700 dark:bg-zinc-900">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={1000}
            disabled={!hasReadyDocuments}
            placeholder={hasReadyDocuments
              ? documentIds.length ? `Ask about ${documentIds.length} selected document${documentIds.length > 1 ? 's' : ''}…` : 'Ask a question across all your documents…'
              : 'Upload a PDF to start asking questions'}
            className="field-sizing-content max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed"
          />
          {busy ? (
            <button type="button" onClick={stop} aria-label="Stop generating"
              className="grid size-9 place-items-center rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim() || !hasReadyDocuments} aria-label="Ask"
              className="grid size-9 place-items-center rounded-xl bg-brand-600 text-white transition hover:bg-brand-700 disabled:bg-zinc-200 disabled:text-zinc-400 dark:disabled:bg-zinc-800">
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-zinc-400">
          Answers use only your documents. Every citation is checked against its source.
        </p>
      </form>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-sm text-white shadow-sm">{text}</p>
    </div>
  );
}

function AssistantBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
        <Sparkles className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-3 text-sm">{children}</div>
    </div>
  );
}

function CitationList({ citations, onOpen }: { citations: Citation[]; onOpen: (c: Citation) => void }) {
  if (!citations.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {citations.map((c) => (
        <button key={c.n} type="button" onClick={() => onOpen(c)} title={`“${c.quote}”`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-1 text-xs transition hover:border-brand-400 hover:bg-brand-50 dark:border-zinc-800 dark:hover:bg-brand-500/10">
          <span className="font-semibold text-brand-700 dark:text-brand-300">{c.n}</span>
          <span className="truncate">{c.documentTitle}</span>
          <span className="shrink-0 text-zinc-400">p. {c.pageStart}</span>
        </button>
      ))}
    </div>
  );
}

function EmptyState({ hasDocuments, onPick, scoped }: { hasDocuments: boolean; onPick: (s: string) => void; scoped: number }) {
  if (!hasDocuments) {
    return (
      <div className="mx-auto max-w-md space-y-3 pt-16 text-center">
        <FileQuestion className="mx-auto size-10 text-zinc-300 dark:text-zinc-700" />
        <h2 className="text-lg font-semibold">Start by uploading a PDF</h2>
        <p className="text-sm text-zinc-500">
          Drop research papers, reports or manuals into the library on the left. Once indexed (usually a few seconds),
          ask anything and get answers cited to the exact page.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-xl space-y-6 pt-16 text-center">
      <div className="space-y-2">
        <Search className="mx-auto size-10 text-brand-300" />
        <h2 className="text-xl font-semibold tracking-tight">What do you want to know?</h2>
        <p className="text-sm text-zinc-500">
          {scoped ? `Questions will search the ${scoped} selected document${scoped > 1 ? 's' : ''}.` : 'Questions search your whole library.'}
        </p>
      </div>
      <div className="grid gap-2">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)}
            className="rounded-xl border border-zinc-200 px-4 py-3 text-left text-sm transition hover:border-brand-400 hover:bg-brand-50/50 dark:border-zinc-800 dark:hover:bg-brand-500/10">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

