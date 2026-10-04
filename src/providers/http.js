/**
 * Shared rate-limit plumbing for provider clients.
 *
 * Both Groq and NVIDIA NIM need the exact same thing: enforce a minimum
 * interval between requests to the provider and retry on HTTP 429 with
 * exponential backoff. Keeping that in one place means a fix to the backoff
 * parsing (see `parseRetryAfter`) applies to every provider at once.
 */

/**
 * Reads a numeric env var, falling back to `fallback` when it is unset or not
 * a finite number. Without this guard a typo in .env (e.g.
 * `GROQ_MAX_RETRIES=abc`) would silently produce `NaN` and break the retry
 * loop in a much more confusing way than "not a number".
 */
export function numFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Parses a `Retry-After` header into milliseconds to wait.
 *
 * RFC 9110 allows two forms: delay-seconds (`"30"`) and an HTTP-date
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Naively running `Number(header)` on the
 * date form yields `NaN`, which turns the backoff sleep into a no-op -- i.e.
 * the retry fires immediately at exactly the moment the provider asked us to
 * wait. Dates are therefore resolved against the current clock, and anything
 * unparseable falls back to `null` so the caller uses exponential backoff.
 *
 * @returns {number|null} milliseconds to wait, or null if the header is absent
 *   or unparseable.
 */
export function parseRetryAfter(headerValue, now = Date.now()) {
  if (headerValue == null) return null;

  const trimmed = String(headerValue).trim();
  if (trimmed === "") return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  return Math.max(0, asDate - now);
}

/**
 * Builds a `fetch` wrapper that self-throttles and retries on 429.
 *
 * Requests are issued sequentially by the caller, so a simple minimum-interval
 * timer plus 429 backoff is enough to stay under provider rate limits -- no
 * token bucket needed.
 *
 * @param {object} params
 * @param {string} params.label - provider name, used in the rate-limit warning.
 * @param {number} params.minIntervalMs - minimum gap between request starts.
 * @param {number} params.maxRetries - how many times to retry a 429.
 * @param {number} [params.maxBackoffMs] - cap for exponential backoff.
 * @returns {(url: string, options?: object) => Promise<Response>}
 */
export function createThrottledFetch({
  label,
  minIntervalMs,
  maxRetries,
  maxBackoffMs = 30_000,
}) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    throw new Error(`createThrottledFetch: minIntervalMs must be a non-negative number, got ${minIntervalMs}`);
  }
  if (!Number.isFinite(maxRetries) || maxRetries < 0) {
    throw new Error(`createThrottledFetch: maxRetries must be a non-negative number, got ${maxRetries}`);
  }

  let lastRequestAt = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function throttle() {
    const waitMs = lastRequestAt + minIntervalMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();
  }

  return async function throttledFetch(url, options) {
    for (let attempt = 0; ; attempt++) {
      await throttle();

      // Guard against a network-level failure too: without this, a single
      // dropped connection aborts the entire eval run.
      let res;
      try {
        res = await fetch(url, options);
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        const backoffMs = Math.min(maxBackoffMs, 1000 * 2 ** attempt);
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `${label} request failed (${message}). Retrying in ${(backoffMs / 1000).toFixed(1)}s ` +
            `(${attempt + 1}/${maxRetries})...`
        );
        await sleep(backoffMs);
        continue;
      }

      if (res.status !== 429) return res;
      if (attempt >= maxRetries) return res; // give up; let the caller surface the error body

      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const backoffMs = retryAfterMs ?? Math.min(maxBackoffMs, 1000 * 2 ** attempt);

      console.warn(
        `Rate limited by ${label} (429). Waiting ${(backoffMs / 1000).toFixed(1)}s before retry ` +
          `${attempt + 1}/${maxRetries}...`
      );
      await sleep(backoffMs);
    }
  };
}