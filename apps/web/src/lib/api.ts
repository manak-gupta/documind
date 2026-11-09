// Typed client for the DocuMind API. Every request goes to /api/* on the same origin
// (Vite's proxy in development, Caddy in production), so the session cookie is sent automatically.

export interface User {
  id: string;
  email: string;
}

export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';

export interface DocumentInfo {
  id: string;
  title: string;
  filename: string;
  sizeBytes: number;
  pageCount: number | null;
  scannedPages: number;
  status: DocumentStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  lastActivityAt?: string;
}

export interface Citation {
  n: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageStart: number;
  pageEnd: number;
  quote: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  trace: MessageTrace | null;  // assistant answers only
  createdAt: string;
}

// What "Why this answer?" shows. Stored with each answer; built from the stream while live.
export interface MessageTrace {
  searchQuery?: string;
  topSimilarity?: number | null;
  chunks: TraceChunk[];
  timings?: AnswerResult['timings'];
  usage?: AnswerResult['usage'];
  rejectedCitations?: number;
  cacheHit?: boolean;
}

export interface UsageSummary {
  questionsToday: number;
  questions7d: number;
  tokensToday: number;
  dailyTokenBudget: number;
  cacheHitPct: number | null;
  ttftP50: number | null;
  ttftP95: number | null;
  totalP50: number | null;
  retrievalP50: number | null;
  citationsRejected: number;
}

export interface TraceChunk {
  n: number;
  id: string;
  documentId: string;
  documentTitle: string;
  pageStart: number;
  pageEnd: number;
  heading: string | null;
  preview: string;
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
  similarity: number | null;
}

export interface AnswerResult {
  messageId: string;
  answer: string;
  citations: Citation[];
  rejectedCitations: number;
  notFound: boolean;
  searchQuery: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  model: string | null;
  timings: { rewriteMs: number; retrievalMs: number; ttftMs: number | null; totalMs: number };
  cacheHit?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: { path: string; message: string }[];

  constructor(status: number, code: string, message: string, issues?: { path: string; message: string }[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body instanceof FormData || body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`, data.issues);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>('GET', '/me'),
  register: (email: string, password: string) => request<{ user: User }>('POST', '/auth/register', { email, password }),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/auth/login', { email, password }),
  logout: () => request<void>('POST', '/auth/logout'),

  listDocuments: () => request<{ documents: DocumentInfo[] }>('GET', '/documents'),
  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ document: DocumentInfo; duplicate: boolean }>('POST', '/documents', form);
  },
  deleteDocument: (id: string) => request<void>('DELETE', `/documents/${id}`),
  documentFileUrl: (id: string) => `/api/documents/${id}/file`,

  listConversations: () => request<{ conversations: Conversation[] }>('GET', '/conversations'),
  createConversation: () => request<{ conversation: Conversation }>('POST', '/conversations'),
  getConversation: (id: string) =>
    request<{ conversation: Conversation; messages: Message[] }>('GET', `/conversations/${id}`),
  deleteConversation: (id: string) => request<void>('DELETE', `/conversations/${id}`),

  usage: () => request<UsageSummary>('GET', '/metrics/summary'),
};
