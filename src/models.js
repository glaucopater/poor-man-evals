// Models under test, run against the full dataset via the chat completions
// endpoint. Edit freely -- any *chat-capable* model id on your Groq account
// can go here.
export const MODELS_UNDER_TEST = [
  "allam-2-7b",
  "qwen/qwen3.6-27b",
  "qwen/qwen3.8-27b",
  "groq/compound",
  "groq/compound-mini",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-safeguard-20b",
];

export const VISION_MODELS = ["qwen/qwen3.6-27b", "qwen/qwen3.8-27b"];

// Not chat-completion models -- included here for reference, but they won't
// work with callGroq()/this harness as-is since they use different Groq
// endpoints and input/output shapes:
//   - canopylabs/orpheus-arabic-saudi, canopylabs/orpheus-v1-english
//       text-to-speech, via POST /openai/v1/audio/speech
//   - whisper-large-v3, whisper-large-v3-turbo
//       speech-to-text, via POST /openai/v1/audio/transcriptions (takes audio input)
//   - meta-llama/llama-prompt-guard-2-22m, meta-llama/llama-prompt-guard-2-86m
//       prompt-injection/jailbreak classifiers, not general chat models
