/**
 * withRetry — exponential-backoff retry wrapper for transient failures.
 *
 * Wraps an async function. On failure that matches retryOn, sleeps with
 * exponential backoff (with jitter) and retries up to maxRetries times.
 *
 * Default retry policy: HTTP 5xx, network errors, and 429 rate-limit responses.
 * Does NOT retry 4xx (other than 429) — those are caller errors.
 *
 * Deadline awareness: when deadlineAt is provided, the next sleep is capped so
 * it doesn't exceed the deadline. If a retry would cross the deadline, throws
 * the last error immediately rather than burning the function's 30s budget on
 * a sleep that runs the clock out. Recommended pattern for inline calls:
 *
 *   await withRetry(() => fetch(...), { deadlineAt: Date.now() + 25_000 });
 *
 * For longer work, use PendingJob retry instead of withRetry.
 *
 * Background: per Findings v6, the platform has transient 502s on entity API
 * (~5 min recovery), and outbound HTTPS calls can hit 429/5xx from any external
 * service. withRetry handles both classes uniformly.
 *
 * Critical: withRetry is for IDEMPOTENT operations. If the wrapped fn is not
 * idempotent (e.g., an Anthropic API call charged per invocation), the retry
 * may cause double-side-effects. Most outbound HTTP calls in this codebase
 * tolerate retry because the upstream service is idempotent or because we
 * accept the cost (Anthropic charges 2x on retry; acceptable for transient
 * recovery).
 */

export interface WithRetryOptions {
  /** Maximum retry attempts after the initial call. Default 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default 250. */
  baseDelayMs?: number;
  /** Maximum delay between retries in ms. Default 5000. */
  maxDelayMs?: number;
  /** Apply random 0.5-1.5x multiplier to each delay. Default true. */
  jitter?: boolean;
  /**
   * Predicate determining whether an error should trigger retry.
   * Default: 5xx HTTP, network errors, and 429.
   */
  retryOn?: (err: any) => boolean;
  /**
   * Optional Date.now()-style millisecond deadline. If a backoff sleep would
   * cross this deadline, withRetry throws immediately instead of sleeping.
   */
  deadlineAt?: number;
  /**
   * Optional callback invoked on each retry attempt with attempt number, error,
   * and computed delay. Useful for observability hooks.
   */
  onRetry?: (info: { attempt: number; error: any; delayMs: number }) => void;
}

/**
 * Default retry predicate. Retries on:
 * - HTTP 5xx (any 5xx status code)
 * - HTTP 429 (rate limit, with backoff)
 * - Network errors (TypeError from fetch failures, ETIMEDOUT, ECONNRESET, etc.)
 * Does NOT retry on:
 * - HTTP 4xx other than 429 (auth, validation, not-found — caller's fault)
 * - Synchronous code errors (TypeErrors from undefined access, etc.)
 */
function defaultRetryOn(err: any): boolean {
  if (!err) return false;

  // HTTP status: try common shapes
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }

  // Network errors: fetch throws TypeError on connection failure
  if (err instanceof TypeError) {
    const msg = String(err.message || '').toLowerCase();
    if (
      msg.includes('fetch') ||
      msg.includes('network') ||
      msg.includes('failed to fetch')
    ) {
      return true;
    }
  }

  // Node-style network error codes (Deno surfaces some via err.code)
  const code = err?.code;
  if (typeof code === 'string') {
    if (
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN'
    ) {
      return true;
    }
  }

  // Conservative default: don't retry unknown error shapes
  return false;
}

function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
): number {
  // Exponential: base * 2^attempt
  let delay = baseDelayMs * Math.pow(2, attempt);
  if (delay > maxDelayMs) delay = maxDelayMs;
  if (jitter) {
    // Random factor 0.5-1.5
    const factor = 0.5 + Math.random();
    delay = delay * factor;
  }
  return Math.floor(delay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 250,
    maxDelayMs = 5000,
    jitter = true,
    retryOn = defaultRetryOn,
    deadlineAt,
    onRetry,
  } = options;

  let lastError: any;

  // Initial attempt + up to maxRetries retries = (maxRetries + 1) total attempts
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // No more retries: throw
      if (attempt === maxRetries) throw err;

      // Error not retryable: throw immediately
      if (!retryOn(err)) throw err;

      // Compute backoff
      const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);

      // Deadline check: if sleeping this long would cross the deadline, throw now
      if (deadlineAt !== undefined) {
        const now = Date.now();
        const remainingMs = deadlineAt - now;
        if (delayMs >= remainingMs) {
          throw err;
        }
      }

      // Observability hook
      if (onRetry) {
        try {
          onRetry({ attempt, error: err, delayMs });
        } catch {
          // Don't let an onRetry hook crash trigger a real failure
        }
      }

      await sleep(delayMs);
    }
  }

  // Unreachable — loop above either returns success or throws — but TypeScript needs it
  throw lastError;
}
