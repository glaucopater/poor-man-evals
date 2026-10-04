// Single place that maps a provider name to its client. `models.js` tags each
// model under test (and the judge) with a provider, and everything else
// dispatches through here -- so adding a provider only means adding a module
// under src/providers/ plus one entry below, not touching runEval.js.
//
// The client modules own their own API's request/response shape, so this file
// only has to deal with the differences in *parameter naming* between the
// OpenAI-compatible providers.
import { callGroq, listGroqModelIds } from "./groq.js";
import { callNvidia, listNvidiaModelIds } from "./nvidia.js";
import { callOllama, listOllamaModelIds, listOllamaModelDetails } from "./ollama.js";

export const PROVIDERS = {
  groq: { label: "Groq", call: callGroq, listModelIds: listGroqModelIds },
  nvidia: { label: "NVIDIA NIM", call: callNvidia, listModelIds: listNvidiaModelIds },
  ollama: {
    label: "Ollama (local)",
    call: callOllama,
    listModelIds: listOllamaModelIds,
    // Optional: lets runEval check vision capability before spending a run on a
    // text-only model.
    listModelDetails: listOllamaModelDetails,
  },
};

// Used for bare-string model entries in models.js.
export const DEFAULT_PROVIDER = "groq";

/**
 * Generation parameters each provider's client actually reads.
 *
 * A dataset may declare parameters its provider does not support -- e.g. the
 * complex-image prompt sets `repeat_penalty`, which only Ollama implements.
 * Anything not listed here is dropped by the client's destructuring, so we
 * check up front and say so instead of letting it vanish. Warning is emitted
 * once per (provider, parameter) rather than once per item, so a 12-item run
 * doesn't print the same line twelve times.
 */
const SUPPORTED_PARAMS = {
  groq: ["model", "messages", "temperature", "max_completion_tokens", "top_p", "response_format"],
  nvidia: ["model", "messages", "temperature", "max_completion_tokens", "top_p", "response_format"],
  ollama: [
    "model",
    "messages",
    "temperature",
    "max_completion_tokens",
    "top_p",
    "response_format",
    "repeat_penalty",
    "think",
    "seed",
    "keep_alive",
  ],
};

const warnedDrops = new Set();

/**
 * Normalizes a `models.js` entry into `{ id, provider }`. Accepts either a bare
 * model id (assumed to run on DEFAULT_PROVIDER) or an explicit
 * `{ id, provider }` object.
 */
export function normalizeModel(entry) {
  if (typeof entry === "string") return { id: entry, provider: DEFAULT_PROVIDER };
  return { id: entry.id, provider: entry.provider ?? DEFAULT_PROVIDER };
}

export function resolveProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `Unknown provider "${name}". Known providers: ${Object.keys(PROVIDERS).join(", ")}.`
    );
  }
  return provider;
}

/**
 * NVIDIA NIM follows the older OpenAI `max_tokens` name, while the Groq client
 * uses the newer `max_completion_tokens`. Call sites pass the Groq name and we
 * translate here, so eval code stays provider-agnostic.
 *
 * Ollama needs no translation at this layer: its client accepts the same
 * parameter names and builds its own native `options`/`format` internally.
 */
function toProviderParams(provider, params) {
  if (provider !== "nvidia") return params;
  const { max_completion_tokens, ...rest } = params;
  return max_completion_tokens == null ? rest : { ...rest, max_tokens: max_completion_tokens };
}

/** Warns once per provider+parameter when a caller passes something unsupported. */
function warnOnUnsupported(provider, params) {
  const supported = SUPPORTED_PARAMS[provider];
  if (!supported) return;

  for (const key of Object.keys(params)) {
    if (supported.includes(key)) continue;
    if (params[key] === undefined) continue;
    const token = `${provider}:${key}`;
    if (warnedDrops.has(token)) continue;
    warnedDrops.add(token);
    console.warn(
      `${PROVIDERS[provider].label} does not support "${key}"; it will be ignored for this run.`
    );
  }
}

/** Calls the right chat-completions client for this model's provider. */
export function callModel({ provider, ...params }) {
  warnOnUnsupported(provider, params);
  return resolveProvider(provider).call(toProviderParams(provider, params));
}

/** Lists the model ids available to the given provider's API key. */
export function listModelIds(provider) {
  return resolveProvider(provider).listModelIds();
}

/** The provider keys that accept a given generation parameter. */
export function providersSupporting(param) {
  return Object.keys(SUPPORTED_PARAMS).filter((p) => SUPPORTED_PARAMS[p].includes(param));
}