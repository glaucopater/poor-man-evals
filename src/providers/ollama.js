/**
 * Local Ollama provider, speaking Ollama's *native* API (`/api/chat`) rather
 * than its OpenAI-compatibility shim.
 *
 * The native API is the right target here even though this harness speaks
 * OpenAI shapes everywhere else, because it is a superset for what a structured
 * vision eval needs:
 *   - `format` takes a full JSON Schema, so structured output is enforced by
 *     the sampler rather than merely requested in prose. The OpenAI-compat
 *     layer only guarantees `{type: "json_object"}`.
 *   - `think` is supported (thinking models can be told not to think).
 *   - `options.repeat_penalty` exists, which the OpenAI-compatible APIs do not.
 *
 * All of that shape translation lives here, so nothing else in the harness
 * needs to know Ollama has a different request format.
 *
 * No API key: a local server has nothing to authenticate. That also means a
 * misconfigured `OLLAMA_BASE_URL` fails with a connection error rather than a
 * 401, so the errors below say "is it running?" explicitly.
 */

import { normalizeCompletionContent } from "./content.js";
import { createThrottledFetch, numFromEnv } from "./http.js";

// Strip a trailing slash so `${BASE}/api/chat` never doubles up.
const BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");

// A local server has no rate limit worth respecting, so the default interval is
// 0. Retries are still on: a cold model load can drop a connection.
const ollamaFetch = createThrottledFetch({
  label: "Ollama",
  minIntervalMs: numFromEnv("OLLAMA_MIN_REQUEST_INTERVAL_MS", 0),
  maxRetries: numFromEnv("OLLAMA_MAX_RETRIES", 2),
  maxBackoffMs: 10_000,
});

/**
 * Converts the harness's OpenAI-style messages into Ollama's native shape.
 *
 * The important part: Ollama wants images as bare base64 in a separate `images`
 * array, with NO `data:image/jpeg;base64,` prefix. Passing the data URL
 * straight through (as an OpenAI `image_url` part) is the obvious move and it
 * fails server-side with an unhelpful decode error.
 *
 * @param {Array<{role: string, content: string | Array<object>}>} messages
 * @returns {Array<{role: string, content: string, images?: string[]}>}
 */
export function toOllamaMessages(messages) {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }

    const textParts = [];
    const images = [];
    for (const part of message.content ?? []) {
      if (part.type === "text") {
        textParts.push(part.text ?? "");
      } else if (part.type === "image_url") {
        const url = part.image_url?.url ?? "";
        // Strip the data-URL prefix; keep a bare base64 string working too.
        images.push(url.startsWith("data:") ? url.slice(url.indexOf(",") + 1) : url);
      }
    }

    const converted = { role: message.role, content: textParts.join("\n") };
    if (images.length > 0) converted.images = images;
    return converted;
  });
}

/**
 * Converts an OpenAI `response_format` into Ollama's `format`.
 *
 * @param {object} [responseFormat]
 * @returns {object|string|undefined} a JSON Schema, the string "json", or
 *   undefined to leave the output unconstrained.
 */
export function toOllamaFormat(responseFormat) {
  if (!responseFormat) return undefined;
  if (responseFormat.type === "json_schema") return responseFormat.json_schema?.schema;
  if (responseFormat.type === "json_object") return "json";
  return undefined;
}

/** Turns the harness's generation options into Ollama's `options` object. */
function toOllamaOptions({ temperature, max_completion_tokens, top_p, repeat_penalty, seed }) {
  const options = {};
  if (temperature !== undefined) options.temperature = temperature;
  if (max_completion_tokens !== undefined) options.num_predict = max_completion_tokens;
  if (top_p !== undefined) options.top_p = top_p;
  if (repeat_penalty !== undefined) options.repeat_penalty = repeat_penalty;
  if (seed !== undefined) options.seed = seed;
  return options;
}

/**
 * Calls Ollama's native chat endpoint.
 *
 * @param {object} params
 * @param {string} params.model - local model id, e.g. "qwen3-vl:2b".
 * @param {Array} params.messages - OpenAI-style messages (translated above).
 * @param {number} [params.temperature]
 * @param {number} [params.max_completion_tokens] - becomes options.num_predict.
 * @param {number} [params.top_p]
 * @param {number} [params.repeat_penalty] - native-only; Groq/NVIDIA lack it.
 * @param {boolean|string} [params.think] - native-only thinking switch.
 * @param {number} [params.seed]
 * @param {object} [params.response_format] - becomes `format` (full schema).
 * @param {string|number} [params.keep_alive] - model unload policy, e.g. "10m".
 * @returns {Promise<{content: string, thinking: string|null, truncated: boolean,
 *   doneReason: string|null, usage: object, raw: object}>}
 */
export async function callOllama({
  model,
  messages,
  temperature,
  max_completion_tokens,
  top_p,
  repeat_penalty,
  think,
  seed,
  response_format,
  keep_alive,
}) {
  const options = toOllamaOptions({ temperature, max_completion_tokens, top_p, repeat_penalty, seed });
  const format = toOllamaFormat(response_format);

  const body = {
    model,
    messages: toOllamaMessages(messages),
    stream: false,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(think !== undefined ? { think } : {}),
    ...(keep_alive !== undefined ? { keep_alive: keep_alive } : {}),
  };

  const res = await ollamaFetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Ollama API error (${res.status} on model "${model}"): ${errText}\n` +
        `Ollama must be running: \`ollama serve\`, and the model pulled: ` +
        `\`ollama pull ${model}\`. Check OLLAMA_BASE_URL (currently ${BASE_URL}).`
    );
  }

  const data = await res.json();

  // Ollama reports token counts under its own names; normalize so runEval's
  // usageDetails (and therefore per-session cost in Langfuse) keep working.
  const promptTokens = data.prompt_eval_count ?? 0;
  const completionTokens = data.eval_count ?? 0;

  return {
    content: normalizeCompletionContent(data),
    // Thinking models emit this separately from content; surfaced so it can be
    // logged, but deliberately not scored.
    thinking: data.message?.thinking ?? null,
    // `done_reason: "length"` means generation stopped because it hit
    // num_predict / the context window -- NOT because the answer finished. That
    // matters a lot for structured-output evals: a response cut off mid-JSON
    // still looks like prose to an LLM judge, and gets graded as a real answer.
    // Note that Ollama silently clamps num_predict to fit the context window, so
    // asking for 8192 output tokens with an 8k window produces exactly this.
    truncated: data.done_reason === "length",
    doneReason: data.done_reason ?? null,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    raw: data,
  };
}

/**
 * Lists the model ids installed on the local server (`GET /api/tags`).
 *
 * Ollama reports the full `name:tag` in both `name` and `model`; both are
 * collected so an id written either way resolves.
 *
 * @returns {Promise<Set<string>>}
 */
export async function listOllamaModelIds() {
  const res = await ollamaFetch(`${BASE_URL}/api/tags`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Ollama API error (${res.status} listing models): ${errText}\n` +
        `Is Ollama running? \`ollama serve\`. Check OLLAMA_BASE_URL (currently ${BASE_URL}).`
    );
  }

  const data = await res.json();
  const ids = new Set();
  for (const entry of data.models ?? []) {
    if (entry.model) ids.add(entry.model);
    if (entry.name) ids.add(entry.name);
  }
  return ids;
}

/**
 * Lists models installed locally, annotated with their reported capabilities.
 * Used by the startup check to tell "model is not pulled" apart from
 * "model is text-only and will reject your image".
 *
 * @returns {Promise<Array<{id: string, vision: boolean, thinking: boolean}>>}
 */
export async function listOllamaModelDetails() {
  const res = await ollamaFetch(`${BASE_URL}/api/tags`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama API error (${res.status} listing models): ${errText}`);
  }
  const data = await res.json();
  return (data.models ?? []).map((entry) => ({
    id: entry.model ?? entry.name,
    vision: Array.isArray(entry.capabilities) && entry.capabilities.includes("vision"),
    thinking: Array.isArray(entry.capabilities) && entry.capabilities.includes("thinking"),
  }));
}