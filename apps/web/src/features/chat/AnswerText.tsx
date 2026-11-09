import { Fragment, type ReactNode } from 'react';
import type { Citation } from '../../lib/api.ts';

interface Props {
  text: string;
  citations: Citation[];       // verified citations; empty while still streaming
  streaming?: boolean;
  onCite?: (c: Citation) => void;
}

// A deliberately small Markdown renderer for answers: paragraphs, bullet and numbered lists,
// **bold**, `code`, and [n] citation markers turned into clickable chips.
// Everything renders as React text nodes, never as HTML, so a hostile answer can't inject markup.
export function AnswerText({ text, citations, streaming, onCite }: Props) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const blocks = text.trim().split(/\n{2,}/);

  return (
    <div className="space-y-3 leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split('\n').filter((l) => l.trim());
        const isLast = i === blocks.length - 1;
        const cursor = streaming && isLast ? <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-blink bg-brand-500" /> : null;

        if (lines.length && lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''), byN, streaming, onCite)}{j === lines.length - 1 && cursor}</li>)}
            </ul>
          );
        }
        if (lines.length && lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''), byN, streaming, onCite)}{j === lines.length - 1 && cursor}</li>)}
            </ol>
          );
        }
        const heading = /^#{1,4}\s+/.test(block);
        return (
          <p key={i} className={heading ? 'font-semibold' : undefined}>
            {lines.map((l, j) => (
              <Fragment key={j}>{j > 0 && <br />}{inline(l.replace(/^#{1,4}\s+/, ''), byN, streaming, onCite)}</Fragment>
            ))}
            {cursor}
          </p>
        );
      })}
    </div>
  );
}

function inline(text: string, byN: Map<number, Citation>, streaming: boolean | undefined, onCite?: (c: Citation) => void): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(part)) {
      return <code key={i} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800">{part.slice(1, -1)}</code>;
    }
    const m = /^\[(\d+)\]$/.exec(part);
    if (m) {
      const n = Number(m[1]);
      const c = byN.get(n);
      if (c) {
        return (
          <button key={i} type="button" onClick={() => onCite?.(c)}
            title={`${c.documentTitle}, p. ${c.pageStart}: “${c.quote}”`}
            className="mx-0.5 inline-flex h-5 min-w-5 -translate-y-0.5 items-center justify-center rounded-md bg-brand-100 px-1 text-[11px] font-semibold text-brand-700 transition hover:bg-brand-600 hover:text-white dark:bg-brand-500/20 dark:text-brand-300">
            {n}
          </button>
        );
      }
      // While streaming, markers aren't verified yet: show them as pending.
      return streaming
        ? <span key={i} className="mx-0.5 inline-flex h-5 min-w-5 -translate-y-0.5 items-center justify-center rounded-md bg-zinc-100 px-1 text-[11px] text-muted dark:bg-zinc-800">{n}</span>
        : null;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
