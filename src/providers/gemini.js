import { createThrottledFetch, numFromEnv } from "./http.js";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.NETLIFY_GOOGLE_API_KEY;

const GEMINI_BASE_URL = (
  process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta"
).replace(/\/+$/, "");

const geminiFetch = createThrottledFetch({
  label: "Gemini",
  minIntervalMs: numFromEnv("GEMINI_MIN_REQUEST_INTERVAL_MS", 0),
  maxRetries: numFromEnv("GEMINI_MAX_RETRIES", 3),
  maxBackoffMs: 10_000,
});

function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages ?? []) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof message.content === "string") {
      if (message.content) parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text" && part.text) parts.push({ text: part.text });
        else if (part.type === "image_url") {
          const url = part.image_url?.url ?? "";
          const match = url.match(/^data:([^;]+);base64,(.*)$/);
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}

export async function callGemini({
  model,
  messages,
  temperature,
  max_completion_tokens,
  top_p,
  response_format,
}) {
  if (!GEMINI_API_KEY) {
    throw new Error("Gemini API key is not set. Add GEMINI_API_KEY (or GOOGLE_API_KEY) to .env.");
  }

  const generationConfig = {};
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (max_completion_tokens !== undefined) generationConfig.maxOutputTokens = max_completion_tokens;
  if (top_p !== undefined) generationConfig.topP = top_p;
  if (response_format?.type === "json_object" || response_format?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
  }
  // Keep evals terse and predictable: disable Gemini 2.5 "thinking" tokens by
  // default, matching the harness default of JUDGE_THINK=false.
  generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body = {
    contents: toGeminiContents(messages),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };

  const normalizedModel = String(model).replace(/^models\//, "");
  const res = await geminiFetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(normalizedModel)}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status} on model "${model}"): ${errText}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content = parts.map((p) => p.text ?? "").join("");
  const finishReason = candidate?.finishReason ?? null;

  const usage = data.usageMetadata ?? {};
  return {
    content,
    truncated: finishReason === "MAX_TOKENS",
    doneReason: finishReason,
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
    },
    raw: data,
  };
}

export async function listGeminiModelIds() {
  if (!GEMINI_API_KEY) {
    throw new Error("Gemini API key is not set. Add GEMINI_API_KEY (or GOOGLE_API_KEY) to .env.");
  }
  const res = await geminiFetch(`${GEMINI_BASE_URL}/models?key=${GEMINI_API_KEY}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status} listing models): ${errText}`);
  }
  const data = await res.json();
  const ids = new Set();
  for (const entry of data.models ?? []) {
    const name = entry.name?.replace(/^models\//, "");
    if (name && (entry.supportedGenerationMethods ?? []).includes("generateContent")) {
      ids.add(name);
    }
  }
  return ids;
}
