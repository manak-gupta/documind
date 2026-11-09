export function Logo({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-brand-600" />
        <path d="M10 8h7a7 7 0 0 1 0 14h-7z" fill="none" stroke="#fff" strokeWidth="2.5" />
        <circle cx="22" cy="23" r="3" fill="#a5b4fc" />
      </svg>
      <span className="text-lg">DocuMind</span>
    </div>
  );
}
