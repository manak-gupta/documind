import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { GlobalWorkerOptions, Util, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api } from '../../lib/api.ts';
import { Spinner } from '../../components/Spinner.tsx';
import { findQuote } from './findQuote.ts';
import type { SourceTarget } from '../chat/ChatView.tsx';

// pdf.js parses in a Web Worker so big PDFs never freeze the page.
GlobalWorkerOptions.workerSrc = workerUrl;

// Each PDF is downloaded once per session, however many citations point into it.
const cache = new Map<string, Promise<PDFDocumentProxy>>();
const load = (documentId: string) => {
  if (!cache.has(documentId)) cache.set(documentId, getDocument({ url: api.documentFileUrl(documentId) }).promise);
  return cache.get(documentId)!;
};

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export default function PdfViewer({ source, onClose }: { source: SourceTarget; onClose: () => void }) {
  const [page, setPage] = useState(source.page);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  // A new citation was clicked: jump to its page.
  useEffect(() => setPage(source.page), [source]);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    setLoading(true);
    setError(null);

    (async () => {
      const pdf = await load(source.documentId);
      if (cancelled) return;
      setPageCount(pdf.numPages);
      const pdfPage = await pdf.getPage(Math.min(Math.max(page, 1), pdf.numPages));

      // Fit the page to the panel width; render at device pixel ratio so text stays sharp.
      const width = containerRef.current?.clientWidth ?? 600;
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: (width - 32) / base.width });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      setSize({ width: viewport.width, height: viewport.height });

      task = pdfPage.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      await task.promise;
      if (cancelled) return;

      // Highlight: only on the cited page, and only the items that contain the quote.
      if (source.quote && page === source.page) {
        const content = await pdfPage.getTextContent();
        const items = content.items.filter((i): i is typeof i & { str: string; transform: number[]; width: number } => 'str' in i);
        const range = findQuote(items.map((i) => i.str), source.quote);
        setBoxes(range ? items.slice(range.first, range.last + 1).filter((i) => i.str.trim()).map((item) => {
          // Item position is in PDF space (origin bottom-left); map it into screen pixels.
          const [, , c, d, x, y] = Util.transform(viewport.transform, item.transform) as number[];
          const height = Math.hypot(c!, d!);
          return { left: x!, top: y! - height, width: item.width * viewport.scale, height: height * 1.15 };
        }) : []);
      } else {
        setBoxes([]);
      }
      setLoading(false);
    })().catch((err: Error) => {
      if (!cancelled && err.name !== 'RenderingCancelledException') {
        setError('Could not load this document.');
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [source, page]);

  // Bring the highlighted passage into view.
  useEffect(() => {
    if (boxes.length) highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [boxes]);

  return (
    <div className="flex h-full flex-col bg-zinc-100 dark:bg-zinc-900">
      <header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{source.title}</p>
          <p className="text-xs text-zinc-500">Page {page}{pageCount ? ` of ${pageCount}` : ''}</p>
        </div>
        <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Previous page"
          className="rounded p-1.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"><ChevronLeft className="size-4" /></button>
        <button type="button" onClick={() => setPage((p) => Math.min(pageCount ?? p, p + 1))} disabled={!!pageCount && page >= pageCount} aria-label="Next page"
          className="rounded p-1.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"><ChevronRight className="size-4" /></button>
        <a href={`${api.documentFileUrl(source.documentId)}#page=${page}`} target="_blank" rel="noreferrer" aria-label="Open PDF in a new tab"
          className="rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ExternalLink className="size-4" /></a>
        <button type="button" onClick={onClose} aria-label="Close source"
          className="rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="size-4" /></button>
      </header>

      {source.quote && page === source.page && (
        <blockquote className="border-b border-zinc-200 bg-amber-50 px-4 py-2 text-xs italic text-amber-900 dark:border-zinc-800 dark:bg-amber-500/10 dark:text-amber-200">
          “{source.quote}”
        </blockquote>
      )}

      <div ref={containerRef} className="relative flex-1 overflow-auto p-4">
        {loading && <div className="absolute inset-0 z-10 grid place-items-center"><Spinner className="size-6 text-brand-500" /></div>}
        {error && <p className="text-center text-sm text-red-600">{error}</p>}
        <div className="relative mx-auto bg-white shadow-lg" style={size ? { width: size.width, height: size.height } : undefined}>
          <canvas ref={canvasRef} style={size ? { width: size.width, height: size.height } : undefined} />
          {boxes.map((b, i) => (
            <div key={i} ref={i === 0 ? highlightRef : undefined}
              className="pointer-events-none absolute rounded-sm bg-amber-300/45 mix-blend-multiply ring-1 ring-amber-400/60"
              style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
          ))}
        </div>
      </div>
    </div>
  );
}
