export interface JsonResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  /** Parsed JSON, the raw text when the body isn't JSON, or null when empty. */
  body: unknown;
}

interface FetchJsonOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * fetch with a deadline that also covers reading the body: on a stalled
 * connection the headers can arrive and the body never finish, which a
 * timeout cleared after `fetch()` resolves would not catch.
 *
 * Rejects on network failure, timeout or `signal` abort.
 */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  { timeoutMs = 15_000, signal }: FetchJsonOptions = {},
): Promise<JsonResponse> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('The request timed out', 'TimeoutError')),
    timeoutMs,
  );

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { ok: response.ok, status: response.status, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'Unknown error';
};
