const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

// Groq's free tier RPM is as low as 10-30 requests/minute depending on the
// model (see https://console.groq.com/docs/rate-limits). This harness makes
// requests sequentially, so a simple minimum-interval throttle plus 429
// retry-with-backoff is enough to stay under the limit without needing a
// full token-bucket implementation. Override via GROQ_MIN_REQUEST_INTERVAL_MS
// if you're on a higher tier and want to move faster.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.GROQ_MIN_REQUEST_INTERVAL_MS ?? 2200);
const MAX_RETRIES = Number(process.env.GROQ_MAX_RETRIES ?? 5);

let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
}

/**
 * fetch() wrapper that self-throttles to respect Groq's low free-tier RPM,
 * and retries on 429 (rate limited) with exponential backoff -- honoring
 * the Retry-After header when Groq sends one.
 */
async function groqFetch(url, options) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    const res = await fetch(url, options);

    if (res.status !== 429) return res;
    if (attempt === MAX_RETRIES) return res; // give up; let the caller surface the error body

    const retryAfterHeader = res.headers.get("retry-after");
    const backoffMs = retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : Math.min(30_000, 1000 * 2 ** attempt);

    console.warn(
      `Rate limited by Groq (429). Waiting ${(backoffMs / 1000).toFixed(1)}s before retry ${
        attempt + 1
      }/${MAX_RETRIES}...`
    );
    await sleep(backoffMs);
  }
}

/**
 * Calls the Groq chat completions endpoint (OpenAI-compatible).
 *
 * @param {object} params
 * @param {string} params.model - Groq model id, e.g. "qwen/qwen3.6-27b".
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {number} [params.temperature]
 * @param {number} [params.max_completion_tokens]
 * @param {number} [params.top_p]
 * @returns {Promise<{content: string, usage: object, raw: object}>}
 */
export async function callGroq({
  model,
  messages,
  temperature = 0.6,
  max_completion_tokens = 2048,
  top_p = 0.95,
}) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set. Copy .env.example to .env and fill it in.");
  }

  const res = await groqFetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_completion_tokens,
      top_p,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status} on model "${model}"): ${errText}`);
  }

  const data = await res.json();

  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage ?? {},
    raw: data,
  };
}

/**
 * Fetches the list of model ids currently available to this Groq API key.
 * Used to fail fast (before burning any eval runs) if a configured model
 * id is misspelled, decommissioned, or not enabled for the account.
 *
 * @returns {Promise<Set<string>>}
 */
export async function listGroqModelIds() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set. Copy .env.example to .env and fill it in.");
  }

  const res = await groqFetch(GROQ_MODELS_URL, {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status} listing models): ${errText}`);
  }

  const data = await res.json();
  return new Set((data.data ?? []).map((m) => m.id));
}
