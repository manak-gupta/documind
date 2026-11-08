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
      await sleep(backoff(attempt, baseDelayMs));
      continue;
    }

    if (res.ok) return res;

    const body = await res.text();
    if (!RETRYABLE.has(res.status) || attempt >= retries) {
      throw new ApiError(res.status, `HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : backoff(attempt, baseDelayMs));
  }
}

const backoff = (attempt: number, base: number) => base * 2 ** attempt + Math.random() * base;
