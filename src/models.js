// Models under test, run against the full dataset via the chat completions
// endpoint. Each entry is `{ id, provider }`, where `provider` is a key from
// src/providers.js ("groq" or "nvidia" today). A bare string still works and
// defaults to Groq, but tag entries explicitly once you mix providers.
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
  { id: "openai/gpt-oss-safeguard-20b", provider: "groq" },

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

// Not chat-completion models -- included here for reference, but they won't
// work with this harness as-is since they use different endpoints and
// input/output shapes:
//   - canopylabs/orpheus-arabic-saudi, canopylabs/orpheus-v1-english
//       text-to-speech, via POST /openai/v1/audio/speech
//   - whisper-large-v3, whisper-large-v3-turbo
//       speech-to-text, via POST /openai/v1/audio/transcriptions (takes audio input)
//   - meta-llama/llama-prompt-guard-2-22m, meta-llama/llama-prompt-guard-2-86m
//       prompt-injection/jailbreak classifiers, not general chat models
