const NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

// NVIDIA NIM rate limits vary by plan and model. Same approach as the Groq
// client: sequential requests plus a minimum-interval throttle and 429
// retry-with-backoff. Override via NVIDIA_MIN_REQUEST_INTERVAL_MS.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.NVIDIA_MIN_REQUEST_INTERVAL_MS ?? 2200);
const MAX_RETRIES = Number(process.env.NVIDIA_MAX_RETRIES ?? 5);

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
 * fetch() wrapper that self-throttles, and retries on 429 (rate limited)
 * with exponential backoff -- honoring the Retry-After header when present.
 */
async function nvidiaFetch(url, options) {
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
      `Rate limited by NVIDIA NIM (429). Waiting ${(backoffMs / 1000).toFixed(1)}s before retry ${
        attempt + 1
      }/${MAX_RETRIES}...`
    );
    await sleep(backoffMs);
  }
}

/**
 * Calls the NVIDIA NIM chat completions endpoint (OpenAI-compatible).
 *
 * @param {object} params
 * @param {string} params.model - NVIDIA model id, e.g. "meta/llama-3.1-70b-instruct".
 * @param {Array<{role: string, content: string | Array<object>}>} params.messages
 *   content is a string for text prompts, or an OpenAI content-parts array
 *   ({type, text} / {type, image_url}) for multimodal (image) prompts.
 * @param {number} [params.temperature]
 * @param {number} [params.max_tokens]
 * @param {number} [params.top_p]
 * @returns {Promise<{content: string, usage: object, raw: object}>}
 */
export async function callNvidia({
  model,
  messages,
  temperature = 0.6,
  max_tokens = 2048,
  top_p = 0.95,
}) {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is not set. Copy .env.example to .env and fill it in.");
  }

  const res = await nvidiaFetch(NVIDIA_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens,
      top_p,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 403) {
      throw new Error(
        `NVIDIA API error (403 on model "${model}"): ${errText}\n` +
          `A 403 "Authorization failed" here is almost always an account/org entitlement ` +
          `problem ("Public API Endpoints" permission missing), not a bad model id or payload. ` +
          `Note GET /v1/models succeeds even without valid auth, so a working model list does ` +
          `NOT prove your key can run inference. See https://forums.developer.nvidia.com/t/383161`
      );
    }
    throw new Error(`NVIDIA API error (${res.status} on model "${model}"): ${errText}`);
  }

  const data = await res.json();

  return {
    content: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage ?? {},
    raw: data,
  };
}

/**
 * Fetches the list of model ids currently available to this NVIDIA API key.
 * Used to fail fast (before burning any eval runs) if a configured model
 * id is misspelled, decommissioned, or not enabled for the account.
 *
 * @returns {Promise<Set<string>>}
 */
export async function listNvidiaModelIds() {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is not set. Copy .env.example to .env and fill it in.");
  }

  const res = await nvidiaFetch(NVIDIA_MODELS_URL, {
    headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`NVIDIA API error (${res.status} listing models): ${errText}`);
  }

  const data = await res.json();
  return new Set((data.data ?? []).map((m) => m.id));
}
