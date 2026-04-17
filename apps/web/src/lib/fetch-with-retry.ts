/**
 * Shared fetch wrapper that survives Fly cold starts.
 *
 * apps/api runs on Fly with auto-stop. First request after idle
 * often lands before the machine boots and returns 502/503. Without
 * a retry, every CRM page would flash "Couldn't load: 503" on the
 * very first navigation after an idle period.
 *
 * Strategy: on 502 or 503, invoke `onWaking` so the caller can show
 * a friendly message, wait ~4s (abortable via the caller's signal),
 * retry once, and surface a cleaner error if the retry also 5xx's.
 */

export interface FetchWithRetryOptions extends RequestInit {
  /** Called once when the first response is 502/503, before the retry delay. */
  onWaking?: () => void;
  /** Delay between the first attempt and the retry. Defaults to 4000. */
  retryDelayMs?: number;
}

const COLD_START_STATUS = new Set([502, 503]);
const DEFAULT_DELAY_MS = 4000;

export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { onWaking, retryDelayMs = DEFAULT_DELAY_MS, signal, ...init } = options;
  // exactOptionalPropertyTypes: spread signal only when present, so
  // the RequestInit we pass to fetch never has `signal: undefined`.
  const withSignal: RequestInit = signal ? { ...init, signal } : { ...init };

  const first = await fetch(url, withSignal);
  if (!COLD_START_STATUS.has(first.status)) return first;

  // First response was a cold-start 5xx — warn the caller + wait +
  // try once more. The caller's abort signal still wins if they
  // navigate away.
  onWaking?.();
  await sleep(retryDelayMs, signal);
  return fetch(url, withSignal);
}

function sleep(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}
