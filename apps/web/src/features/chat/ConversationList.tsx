import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Trash2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../lib/api.ts';

export function ConversationList({ activeId }: { activeId?: string }) {
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => (await api.listConversations()).conversations,
  });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConversation(id),
    onSuccess: (_d, id) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (id === activeId) navigate('/');
    },
  });

  if (!conversations.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Conversations</h2>
      <ul className="space-y-0.5">
        {conversations.map((c) => (
          <li key={c.id} className="group relative">
            <Link to={`/c/${c.id}`}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 pr-8 text-sm transition ${
                c.id === activeId ? 'bg-zinc-200/70 font-medium dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'}`}>
              <MessageSquare className="size-3.5 shrink-0 text-zinc-400" />
              <span className="truncate">{c.title}</span>
            </Link>
            <button type="button" aria-label={`Delete conversation ${c.title}`}
              onClick={() => { if (confirm('Delete this conversation?')) remove.mutate(c.id); }}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 opacity-0 transition hover:text-red-600 group-hover:opacity-100 focus:opacity-100">
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
