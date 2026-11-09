import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, Menu, PenSquare, X } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { Logo } from '../../components/Logo.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { useMe } from '../auth/useMe.ts';
import { Library } from '../library/Library.tsx';
import { useDocuments } from '../library/useDocuments.ts';
import { ChatView, type SourceTarget } from '../chat/ChatView.tsx';
import { ConversationList } from '../chat/ConversationList.tsx';
import { UsageMeter } from './UsageMeter.tsx';

// pdf.js is the heaviest dependency; it's only downloaded when a source is first opened.
const PdfViewer = lazy(() => import('../viewer/PdfViewer.tsx'));

export function Workspace() {
  // useMatch (not useParams): the Workspace stays mounted while the URL switches between
  // "/" and "/c/:id", so a streaming answer isn't lost when a new conversation is created.
  const conversationId = useMatch('/c/:conversationId')?.params.conversationId;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { data: documents = [] } = useDocuments();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<SourceTarget | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // On mobile, picking a conversation in the slide-over menu should close the menu.
  useEffect(() => setSidebarOpen(false), [conversationId]);

  // Forget selections of documents that were deleted.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => documents.some((d) => d.id === id && d.status === 'ready'))));
  }, [documents]);

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const createConversation = useCallback(async () => {
    const { conversation } = await api.createConversation();
    navigate(`/c/${conversation.id}`);
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    return conversation.id;
  }, [navigate, queryClient]);

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(['me'], null);
      navigate('/login');
    },
  });

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between p-4">
        <Logo />
        <button type="button" onClick={() => setSidebarOpen(false)} className="rounded p-1 lg:hidden" aria-label="Close menu"><X className="size-4" /></button>
      </div>
      <div className="px-3">
        <button type="button" onClick={() => { navigate('/'); setSidebarOpen(false); }}
          className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium shadow-sm transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800">
          <PenSquare className="size-4" /> New conversation
        </button>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
        <Library selected={selected} onToggle={toggle} />
        <ConversationList activeId={conversationId} />
      </div>
      <div className="px-3 pb-3"><UsageMeter /></div>
      <div className="flex items-center gap-2 border-t border-zinc-200 p-3 text-sm dark:border-zinc-800">
        <span className="grid size-7 place-items-center rounded-full bg-brand-100 text-xs font-semibold uppercase text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
          {me?.email[0]}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">{me?.email}</span>
        <button type="button" onClick={() => logout.mutate()} aria-label="Sign out" title="Sign out"
          className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><LogOut className="size-4" /></button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Sidebar: fixed column on desktop, slide-over on mobile */}
      <aside className="hidden w-72 shrink-0 border-r border-zinc-200 bg-zinc-50/70 lg:block dark:border-zinc-800 dark:bg-zinc-950">{sidebar}</aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-80 max-w-[85%] bg-white shadow-xl dark:bg-zinc-950">{sidebar}</aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 lg:hidden dark:border-zinc-800">
          <button type="button" onClick={() => setSidebarOpen(true)} className="rounded p-1.5" aria-label="Open menu"><Menu className="size-5" /></button>
          <Logo />
        </div>
        <div className="min-h-0 flex-1">
          <ChatView
            conversationId={conversationId}
            documentIds={[...selected]}
            hasReadyDocuments={documents.some((d) => d.status === 'ready')}
            createConversation={createConversation}
            onOpenSource={setSource}
          />
        </div>
      </main>

      {source && (
        <section className="fixed inset-0 z-30 border-l border-zinc-200 xl:static xl:w-[46%] xl:max-w-3xl xl:shrink-0 dark:border-zinc-800">
          <Suspense fallback={<div className="grid h-full place-items-center bg-zinc-100 dark:bg-zinc-900"><Spinner className="size-6 text-brand-500" /></div>}>
            <PdfViewer source={source} onClose={() => setSource(null)} />
          </Suspense>
        </section>
      )}
    </div>
  );
}
