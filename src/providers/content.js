/**
 * Helpers for reading a chat completion response body.
 *
 * Not every provider is OpenAI-compatible at the *response* level even when it
 * is at the request level, and `message.content` is not reliably a plain string
 * across models:
 *   - it can be `null`/absent when a reasoning model spends its whole budget
 *     on thinking tokens,
 *   - it can be an array of content parts (`{type:"text", text}`),
 *   - the text may live under `reasoning_content` / `reasoning` / `thinking`.
 *
 * Normalizing here means the judge never receives a non-string and silently
 * degrades to "failed to parse".
 */

/**
 * Extracts the assistant text from a chat completion response body.
 *
 * Handles both response shapes in use here:
 *   - OpenAI-compatible: `{ choices: [{ message: {...} }] }` (Groq, NVIDIA)
 *   - Ollama native:     `{ message: {...} }`
 *
 * @param {object} data - parsed chat completion response
 * @returns {string} the assistant message text, or "" when there is none.
 */
export function normalizeCompletionContent(data) {
  const message = data?.choices?.[0]?.message ?? data?.message;
  if (!message) return "";

  const { content } = message;

  if (typeof content === "string" && content.trim() !== "") return content;

  // Multimodal responses return an array of parts; join the text ones.
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (text !== "") return text;
  }

  // Reasoning models can leave `content` empty and put the text under a
  // separate field: gpt-oss on Groq uses `reasoning_content`, Ollama's native
  // API calls it `thinking`.
  const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
  if (typeof reasoning === "string" && reasoning.trim() !== "") return reasoning;

  return typeof content === "string" ? content : "";
}