const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

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

  const res = await fetch(GROQ_CHAT_URL, {
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

  const res = await fetch(GROQ_MODELS_URL, {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status} listing models): ${errText}`);
  }

  const data = await res.json();
  return new Set((data.data ?? []).map((m) => m.id));
}
