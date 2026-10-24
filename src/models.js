// Models under test, run against the full dataset via the chat completions
// endpoint. Each entry is `{ id, provider }`, where `provider` is a key from
// src/providers/index.js ("groq", "nvidia" or "ollama"). A bare string still
// works and defaults to Groq, but tag entries explicitly once you mix
// providers.
//
// An entry may also carry per-model generation parameters that are forwarded
// only for that model, e.g. `{ id, provider, reasoning_effort: "max" }`. They
// are passed to the provider client as-is (see normalizeModel in
// src/providers/index.js), so they must be names the provider's client accepts;
// unsupported ones are reported once per run and dropped.
//
// Edit freely -- any *chat-capable* model id on that provider's account works.
// The NVIDIA catalogs also list embeddings, rerankers, safety classifiers,
// OCR/parse models and reward models; those aren't chat completions and will
// not work here.
export const MODELS_UNDER_TEST = [
  // --- Groq ---
  { id: "allam-2-7b", provider: "groq" },
  { id: "qwen/qwen3.8-27b", provider: "groq" },
  { id: "openai/gpt-oss-120b", provider: "groq" },
  { id: "openai/gpt-oss-20b", provider: "groq" },

  // --- NVIDIA NIM ---
  // Only ids verified to actually answer on this account are listed. NVIDIA's
  // GET /v1/models also returns ids that then 404 ("Function not found for
  // account") at inference: microsoft/phi-3-vision-128k-instruct,
  // moonshotai/kimi-k2.6, mistralai/mistral-large-2-instruct, 01-ai/yi-large and
  // zyphra/zamba2-7b-instruct were all listed but dead, and
  // deepseek-ai/deepseek-v4.1-flash never answered within 5 minutes. Getting an
  // id into this list means it passed a real 1-token completion, not that it
  // appeared in the catalog.
  { id: "z-ai/glm-5.3", provider: "nvidia" },
  { id: "nvidia/nemotron-3-super-120b-a12b", provider: "nvidia" },
  { id: "nvidia/nemotron-3.5-lightning-30b-a3b", provider: "nvidia" },
  { id: "google/gemma-4-31b-it", provider: "nvidia" },

  // Same model as the Groq entry above, on a second provider -- the summary
  // prints `openai/gpt-oss-20b (groq)` next to `openai/gpt-oss-20b (nvidia)`
  // so you can compare providers directly.
  { id: "openai/gpt-oss-20b", provider: "nvidia" },
];

// Image dataset only. Add vision-capable models here, tagged with their provider.
// Same rule as above: listed by NVIDIA is not the same as usable.
// microsoft/phi-3-vision-128k-instruct 404'd and meta/llama-3.2-90b-vision-instruct
// hung for 15 minutes, so both were dropped.
export const VISION_MODELS = [
  { id: "qwen/qwen3.8-27b", provider: "groq" },
  { id: "nvidia/nemotron-3.5-super-vl-120b-a12b", provider: "nvidia", reasoning_effort: "max" },
  { id: "meta/llama-3.2-11b-vision-instruct", provider: "nvidia" },
];

// Gemini models used by the freeprompt app (provider: "gemini"). These run
// through Google's Generative Language API, so GEMINI_API_KEY must be set.
export const GEMINI_MODELS = [
  { id: "gemini-3.1-flash-lite", provider: "gemini" },
  { id: "gemini-3.5-flash", provider: "gemini" },
  { id: "gemini-2.5-flash", provider: "gemini" },
  { id: "gemini-2.5-flash-lite", provider: "gemini" },
];
// Locally installed Ollama models (provider: "ollama"). No API key, no rate
// limit, no cost -- which is what makes them useful as a baseline to compare
// the hosted models against.
//
// The ids below are whatever `ollama list` reports on this machine. The harness
// fails fast and prints the local catalog if one is missing, so a stale entry
// here is a one-line fix rather than a confusing mid-run error. Vision
// capability is checked at startup too, so a text-only model is reported as
// such instead of silently ignoring an image.
export const LOCAL_MODELS = [
  { id: "qwen3-vl:2b", provider: "ollama" },
  { id: "qwen3.8:27b", provider: "ollama" },
  { id: "qwen3.5:9b", provider: "ollama" },
  { id: "gemma4:12b", provider: "ollama" },
  { id: "gemma4:e2b", provider: "ollama" },
  { id: "llava:latest", provider: "ollama" },
];

// Every local model installed here is also vision-capable (`ollama show` reports
// the vision capability for all six), so one list serves both the text and image
// datasets. Split it if you pull a text-only model -- the vision datasets must
// not silently include it.
export const LOCAL_VISION_MODELS = LOCAL_MODELS;

// The lists the datasets actually run: local models first, because they are free
// and fast, then the hosted ones. `run.enabled_providers` in eval.config.yaml
// (or ENABLED_PROVIDERS) narrows this at runtime, so a profile of `local` runs
// only the Ollama entries and a profile of `hosted` runs only the paid ones.
//
// Keeping local models in the same list -- rather than in a separate exported
// array a caller has to remember to concatenate -- is what stops a dataset from
// silently having zero runnable models under a local profile.
export const CHAT_MODELS = [...LOCAL_MODELS, ...MODELS_UNDER_TEST];
export const VISION_MODELS_ALL = [...LOCAL_VISION_MODELS, ...VISION_MODELS];

// Not chat-completion models -- included here for reference, but they won't
// work with this harness as-is since they use different endpoints and
// input/output shapes:
//   - canopylabs/orpheus-arabic-saudi, canopylabs/orpheus-v1-english
//       text-to-speech, via POST /openai/v1/audio/speech
//   - whisper-large-v3, whisper-large-v3-turbo
//       speech-to-text, via POST /openai/v1/audio/transcriptions (takes audio input)
//   - meta-llama/llama-prompt-guard-2-22m, meta-llama/llama-prompt-guard-2-86m
//       prompt-injection/jailbreak classifiers, not general chat models
//   - openai/gpt-oss-safeguard-20b
//       Groq content-moderation classifier; it has no chat completions API, so
//       it was previously listed under MODELS_UNDER_TEST where every call 400s
