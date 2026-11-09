import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DocumentInfo } from '../../lib/api.ts';

const KEY = ['documents'];

export function useDocuments() {
  return useQuery({ queryKey: KEY, queryFn: async () => (await api.listDocuments()).documents });
}

type DocumentEvent = Pick<DocumentInfo, 'status' | 'stage' | 'progress' | 'error' | 'pageCount'> & { documentId: string };

// Live ingestion progress. The server pushes an event at every stage change; we patch the
// matching document in the query cache, so every component showing it re-renders.
// EventSource reconnects by itself if the connection drops.
export function useDocumentEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource('/api/documents/events');
    source.addEventListener('document', (msg) => {
      const e = JSON.parse((msg as MessageEvent<string>).data) as DocumentEvent;
      queryClient.setQueryData<DocumentInfo[]>(KEY, (docs) =>
        docs?.map((d) => (d.id === e.documentId
          ? { ...d, status: e.status, stage: e.stage, progress: e.progress, error: e.error, pageCount: e.pageCount ?? d.pageCount }
          : d)));
      // The worker may also have changed the title (from PDF metadata): refetch once it's done.
      if (e.status === 'ready' || e.status === 'failed') void queryClient.invalidateQueries({ queryKey: KEY });
    });
    return () => source.close();
  }, [queryClient]);
}

export function useUploadDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.uploadDocument(file),
    onSuccess: ({ document }) => {
      queryClient.setQueryData<DocumentInfo[]>(KEY, (docs = []) =>
        docs.some((d) => d.id === document.id) ? docs : [document, ...docs]);
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteDocument(id),
    // Optimistic: remove it from the list immediately; put it back if the server refuses.
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const previous = queryClient.getQueryData<DocumentInfo[]>(KEY);
      queryClient.setQueryData<DocumentInfo[]>(KEY, (docs) => docs?.filter((d) => d.id !== id));
      return { previous };
    },
    onError: (_err, _id, ctx) => queryClient.setQueryData(KEY, ctx?.previous),
  });
}
