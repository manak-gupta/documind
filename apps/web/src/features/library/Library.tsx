import { type DragEvent, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Trash2, UploadCloud } from 'lucide-react';
import { ApiError, type DocumentInfo } from '../../lib/api.ts';
import { Spinner } from '../../components/Spinner.tsx';
import { useDeleteDocument, useDocumentEvents, useDocuments, useUploadDocument } from './useDocuments.ts';

interface Props {
  selected: Set<string>;                  // documents the next question is scoped to (empty = all)
  onToggle: (id: string) => void;
}

export function Library({ selected, onToggle }: Props) {
  const { data: documents = [], isPending } = useDocuments();
  useDocumentEvents();
  const upload = useUploadDocument();
  const remove = useDeleteDocument();
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const uploadFiles = async (files: File[]) => {
    setErrors([]);
    for (const file of files) {
      try {
        await upload.mutateAsync(file);
      } catch (err) {
        setErrors((e) => [...e, `${file.name}: ${err instanceof ApiError ? err.message : 'upload failed'}`]);
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void uploadFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Library</h2>
        {selected.size > 0 && <span className="text-xs text-brand-600 dark:text-brand-400">{selected.size} selected</span>}
      </div>

      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed px-3 py-4 text-center text-sm transition ${
          dragging
            ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10'
            : 'border-zinc-300 hover:border-brand-400 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900'
        }`}
      >
        {upload.isPending ? <Spinner className="size-5 text-brand-600" /> : <UploadCloud className="size-5 text-zinc-400" />}
        <span className="font-medium">{upload.isPending ? 'Uploading…' : 'Drop PDFs or click to upload'}</span>
        <span className="text-xs text-zinc-500">Text-based PDFs, up to 25 MB</span>
      </button>
      <input ref={input} type="file" accept="application/pdf" multiple hidden
        onChange={(e) => { void uploadFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />

      {errors.map((m) => (
        <p key={m} className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300">{m}</p>
      ))}

      {isPending ? (
        <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />)}</div>
      ) : documents.length === 0 ? (
        <p className="px-1 text-xs text-zinc-500">No documents yet. Upload a PDF to start asking questions.</p>
      ) : (
        <ul className="space-y-1">
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} checked={selected.has(doc.id)} onToggle={() => onToggle(doc.id)}
              onDelete={() => { if (confirm(`Delete "${doc.title}"? This removes it and its search index.`)) remove.mutate(doc.id); }} />
          ))}
        </ul>
      )}
    </section>
  );
}

const STAGE_LABEL: Record<string, string> = { parsing: 'Reading PDF', embedding: 'Indexing', retrying: 'Retrying' };

function DocumentRow({ doc, checked, onToggle, onDelete }: { doc: DocumentInfo; checked: boolean; onToggle: () => void; onDelete: () => void }) {
  const ready = doc.status === 'ready';
  return (
    <li className="group rounded-lg px-2 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-900">
      <div className="flex items-start gap-2">
        <input type="checkbox" checked={checked} onChange={onToggle} disabled={!ready}
          title="Limit questions to the selected documents"
          className="mt-1 size-3.5 accent-brand-600 disabled:opacity-30" />
        <FileText className="mt-0.5 size-4 shrink-0 text-zinc-400" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={doc.title}>{doc.title}</p>
          <p className="flex items-center gap-1 text-xs text-zinc-500">
            {ready && <><CheckCircle2 className="size-3 text-emerald-500" />{doc.pageCount} pages</>}
            {doc.status === 'failed' && <span className="flex items-center gap-1 text-red-600 dark:text-red-400" title={doc.error ?? ''}><AlertCircle className="size-3" />{doc.error ?? 'Failed'}</span>}
            {(doc.status === 'queued' || doc.status === 'processing') && (
              <span>{doc.stage ? STAGE_LABEL[doc.stage] ?? doc.stage : 'Queued'}{doc.progress > 0 && ` · ${doc.progress}%`}</span>
            )}
          </p>
          {(doc.status === 'queued' || doc.status === 'processing') && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div className="h-full rounded-full bg-brand-500 transition-all duration-500" style={{ width: `${Math.max(doc.progress, 4)}%` }} />
            </div>
          )}
        </div>
        <button type="button" onClick={onDelete} aria-label={`Delete ${doc.title}`}
          className="rounded p-1 text-zinc-400 opacity-0 transition hover:bg-zinc-200 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 dark:hover:bg-zinc-800">
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </li>
  );
}
