// fetch with retries, for calling rate-limited AI APIs.
//
// Retries: 429 (rate limited), 5xx (provider trouble), network errors and timeouts.
// Never retries other 4xx (bad request, bad key): retrying can't fix those.
// Delay: exponential (1s, 2s, 4s, ...) + random jitter, so many clients that were limited
// at the same moment don't all retry in the same instant. If the server sends Retry-After,
// we wait exactly that long instead.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;                    // injectable for tests
  sleep?: (ms: number) => Promise<void>;       // injectable for tests
  maxServerDelayMs?: number;                   // never wait longer than this, whatever the server asks
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function fetchJsonWithRetry<T>(url: string, init: RequestInit, opts: RetryOptions = {}): Promise<T> {
  return (await (await fetchWithRetry(url, init, opts)).json()) as T;
}

// Returns the successful Response without reading its body, so callers can stream it.
// Retries only happen BEFORE the body starts: once tokens are flowing to a user,
// silently restarting the answer would duplicate text.
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions = {}): Promise<Response> {
  const callerSignal = init.signal ?? undefined; // DOM typings allow null here
  const {
    retries = 4,
    baseDelayMs = 1_000,
    timeoutMs = 30_000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxServerDelayMs = 120_000,
    onRetry = defaultOnRetry,
  } = opts;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      // Abort on timeout OR when the caller cancels (e.g. the user closed the tab).
      const signals = [AbortSignal.timeout(timeoutMs), ...(callerSignal ? [callerSignal] : [])];
      res = await fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
    } catch (err) {
      // Network failure or timeout. A deliberate cancel is never retried.
      if (callerSignal?.aborted || attempt >= retries) throw err;
      const delayMs = backoff(attempt, baseDelayMs);
      onRetry({ attempt: attempt + 1, delayMs, reason: (err as Error).message });
      await sleep(delayMs);
      continue;
    }

    if (res.ok) return res;

    const body = await res.text();
    if (!RETRYABLE.has(res.status) || attempt >= retries) {
      throw new ApiError(res.status, `HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const delayMs = serverDelayMs(res, body) ?? backoff(attempt, baseDelayMs);
    // A huge requested delay (e.g. a daily quota) means "not today": fail clearly instead of
    // silently hanging a job for an hour. (Found when an eval run stalled with no output.)
    if (delayMs > maxServerDelayMs) {
      throw new ApiError(res.status, `HTTP ${res.status}: server asked to retry in ${Math.round(delayMs / 1000)} s; giving up. ${body.slice(0, 300)}`);
    }
    onRetry({ attempt: attempt + 1, delayMs, reason: `HTTP ${res.status}` });
    await sleep(delayMs);
  }
}

const defaultOnRetry = ({ attempt, delayMs, reason }: { attempt: number; delayMs: number; reason: string }) =>
  console.warn(JSON.stringify({ level: 'warn', msg: 'retrying AI API call', attempt, delayMs: Math.round(delayMs), reason }));

// How long the server asked us to wait, if it said: the standard Retry-After header, or
// Google's RetryInfo in the error body ("retryDelay": "37s"). Quota windows are often a full
// minute, so guessing with short exponential backoff just burns the retry budget.
export function serverDelayMs(res: Response, body: string): number | null {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1_000;
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.ceil(Number(m[1]) * 1_000) + 500 : null;
}

const backoff = (attempt: number, base: number) => base * 2 ** attempt + Math.random() * base;
