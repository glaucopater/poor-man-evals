// Models under test, run against the full dataset via the chat completions
// endpoint. Each entry is `{ id, provider }`, where `provider` is a key from
// src/providers/index.js ("groq", "nvidia" or "ollama"). A bare string still
// works and defaults to Groq, but tag entries explicitly once you mix
// providers.
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
  { id: "deepseek-ai/deepseek-v4.1-flash", provider: "nvidia" },
  { id: "moonshotai/kimi-k3", provider: "nvidia" },
  { id: "z-ai/glm-5.3", provider: "nvidia" },
  { id: "nvidia/nemotron-3-super-120b-a12b", provider: "nvidia" },
  { id: "mistralai/mistral-large-2-instruct", provider: "nvidia" },
  { id: "google/gemma-4-31b-it", provider: "nvidia" },
  { id: "01-ai/yi-large", provider: "nvidia" },
  { id: "zyphra/zamba2-7b-instruct", provider: "nvidia" },

  // Same model as the Groq entry above, on a second provider -- the summary
  // prints `openai/gpt-oss-20b (groq)` next to `openai/gpt-oss-20b (nvidia)`
  // so you can compare providers directly.
  { id: "openai/gpt-oss-20b", provider: "nvidia" },
];

// Image dataset only. Add vision-capable models here, tagged with their provider.
export const VISION_MODELS = [
  { id: "qwen/qwen3.8-27b", provider: "groq" },
  { id: "meta/llama-3.2-90b-vision-instruct", provider: "nvidia" },
  { id: "meta/llama-3.2-11b-vision-instruct", provider: "nvidia" },
  { id: "microsoft/phi-3-vision-128k-instruct", provider: "nvidia" },
];

// Locally installed Ollama models (provider: "ollama"). No API key, no rate
// limit, no cost -- which is what makes them useful as a baseline to compare
// the hosted models against.
//
// The ids below are whatever `ollama list` reports on this machine. The harness
// fails fast and prints the local catalog if one is missing, so a stale entry
// here is a one-line fix rather than a confusing mid-run error. Vision
// capability is checked at startup too, so a text-only model is reported as
// such instead of silently ignoring the image.
export const LOCAL_VISION_MODELS = [
  { id: "qwen3-vl:2b", provider: "ollama" },
  { id: "qwen3.8:27b", provider: "ollama" },
  { id: "qwen3.5:9b", provider: "ollama" },
  { id: "gemma4:12b", provider: "ollama" },
  { id: "gemma4:e2b", provider: "ollama" },
  { id: "llava:latest", provider: "ollama" },
];

// The complex-image dataset runs against local models *and* the hosted vision
// models, so one run answers both "is this prompt any good?" and "does a small
// local model hold up?".
//
// Narrow it with ENABLED_PROVIDERS, e.g. `ENABLED_PROVIDERS=ollama` for a fully
// local, zero-cost run. Set JUDGE_PROVIDER=ollama and JUDGE_MODEL to a local id
// as well, or the judge still calls Groq and the run still needs a Groq key.
export const COMPLEX_IMAGE_MODELS = [...LOCAL_VISION_MODELS, ...VISION_MODELS];

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
