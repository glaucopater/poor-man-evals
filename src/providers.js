// Single place that maps a provider name to its client. `models.js` tags each
// model under test (and the judge) with a provider, and everything else
// dispatches through here -- so adding a provider only means adding an entry
// below plus its client module, not touching runEval.js.
import { callGroq, listGroqModelIds } from "./groqClient.js";
import { callNvidia, listNvidiaModelIds } from "./nvidiaClient.js";

export const PROVIDERS = {
  groq: { label: "Groq", call: callGroq, listModelIds: listGroqModelIds },
  nvidia: { label: "NVIDIA NIM", call: callNvidia, listModelIds: listNvidiaModelIds },
};

// Used for bare-string model entries in models.js.
export const DEFAULT_PROVIDER = "groq";

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
 */
function toProviderParams(provider, params) {
  if (provider !== "nvidia") return params;
  const { max_completion_tokens, ...rest } = params;
  return max_completion_tokens == null ? rest : { ...rest, max_tokens: max_completion_tokens };
}

/** Calls the right chat-completions client for this model's provider. */
export function callModel({ provider, ...params }) {
  return resolveProvider(provider).call(toProviderParams(provider, params));
}

/** Lists the model ids available to the given provider's API key. */
export function listModelIds(provider) {
  return resolveProvider(provider).listModelIds();
}
