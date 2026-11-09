import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileSearch, Quote, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../../lib/api.ts';
import { Logo } from '../../components/Logo.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { useMe } from './useMe.ts';

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: me } = useMe();

  const auth = useMutation({
    mutationFn: () => (mode === 'login' ? api.login(email, password) : api.register(email, password)),
    onSuccess: ({ user }) => {
      queryClient.setQueryData(['me'], user);
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    },
  });

  if (me) return <Navigate to="/" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    auth.mutate();
  };
  const err = auth.error instanceof ApiError ? auth.error : null;
  const fieldError = (field: string) => err?.issues?.find((i) => i.path === field)?.message;

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      {/* Pitch panel */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-700 via-brand-600 to-indigo-500 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Logo className="text-white" />
        <div className="max-w-md space-y-8">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Ask your PDFs anything. Get answers you can verify.
          </h1>
          <ul className="space-y-4 text-brand-100">
            <Feature icon={<FileSearch className="size-5" />} text="Hybrid search across every document: meaning and exact terms." />
            <Feature icon={<Quote className="size-5" />} text="Every claim cited to the document, page and exact passage." />
            <Feature icon={<ShieldCheck className="size-5" />} text="Citations are checked against the source before you see them." />
          </ul>
        </div>
        <p className="text-sm text-brand-100/80">Open source · built with React, Node.js, PostgreSQL + pgvector</p>
        <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-white/10 blur-3xl" />
      </div>

      {/* Form */}
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-6">
          <div className="space-y-2">
            <Logo className="lg:hidden" />
            <h2 className="text-2xl font-semibold tracking-tight">
              {mode === 'login' ? 'Welcome back' : 'Create your account'}
            </h2>
            <p className="text-sm text-zinc-500">
              {mode === 'login' ? 'Sign in to your document library.' : 'Free. Upload PDFs and start asking questions.'}
            </p>
          </div>

          <div className="space-y-4">
            <Field label="Email" error={fieldError('email')}>
              <input type="email" required autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="you@example.com" />
            </Field>
            <Field label="Password" error={fieldError('password')}>
              <input type="password" required minLength={8} value={password}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="At least 8 characters" />
            </Field>
          </div>

          {err && !err.issues && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
              {err.message}
            </p>
          )}

          <button type="submit" disabled={auth.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60">
            {auth.isPending && <Spinner className="size-4" />}
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>

          <p className="text-center text-sm text-zinc-500">
            {mode === 'login' ? 'New here? ' : 'Already have an account? '}
            <button type="button" className="font-medium text-brand-600 hover:underline dark:text-brand-400"
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); auth.reset(); }}>
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm outline-none transition placeholder:text-zinc-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 dark:border-zinc-700 dark:bg-zinc-900';

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error && <span className="block text-xs text-red-600 dark:text-red-400">{error}</span>}
    </label>
  );
}

function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 rounded-md bg-white/15 p-1.5">{icon}</span>
      <span>{text}</span>
    </li>
  );
}
