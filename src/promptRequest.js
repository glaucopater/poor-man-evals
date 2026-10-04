/**
 * Reads a captured model request (the `complex_prompt.md` file) and maps it onto
 * the OpenAI-compatible shape this harness speaks.
 *
 * The file was exported from Ollama, so it uses that API's vocabulary:
 *
 *   format  -> a raw JSON Schema                => response_format.json_schema
 *   options.num_predict                        => max_completion_tokens
 *   options.temperature / repeat_penalty       => temperature / (see below)
 *   messages[].images[]                        => an OpenAI `image_url` content part
 *
 * Anything it cannot map is reported by `warnings` rather than dropped silently,
 * because a silently-ignored `num_predict` or a dropped image would show up later
 * as a mysteriously truncated or hallucinated eval.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO_ROOT } from "./images.js";

/**
 * Ollama embeds image references as a template expression rather than a path:
 *   `${[ fs.readFile(path=b64'<base64 of the path>', encoding='base64') ]}`
 * The path itself is base64 so it survives being embedded in JSON.
 */
const OLLAMA_IMAGE_TEMPLATE = /\$\{\[\s*fs\.readFile\(\s*path=b64'([^']*)'\s*,\s*encoding='base64'\s*\)\s*\]\}/g;

/**
 * Pulls the filesystem paths out of an Ollama image template expression.
 * @returns {string[]} decoded paths (still possibly absolute/stale).
 */
export function extractOllamaImagePaths(text) {
  const paths = [];
  for (const match of text.matchAll(OLLAMA_IMAGE_TEMPLATE)) {
    try {
      paths.push(Buffer.from(match[1], "base64").toString("utf8"));
    } catch {
      /* not base64; ignore */
    }
  }
  return paths;
}

/**
 * Loads a captured request file and returns the harness-shaped pieces.
 *
 * @param {string} filePath - repo-relative or absolute path to the JSON file.
 * @returns {{
 *   prompt: string,
 *   schema: object|null,
 *   options: object,
 *   warnings: string[],
 *   referencedImages: string[]
 * }}
 */
export function loadPromptRequest(filePath) {
  const absolute = resolve(REPO_ROOT, filePath);
  const warnings = [];

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (err) {
    throw new Error(
      `${filePath} is not valid JSON. This file is a captured model request in ` +
        `JSON form despite the .md extension, so it must parse as JSON: ${err.message}`
    );
  }

  const userMessage = (parsed.messages ?? []).find((m) => m.role === "user");
  if (!userMessage) {
    throw new Error(`${filePath} has no messages[] entry with role "user".`);
  }

  // --- structured output ------------------------------------------------
  // Ollama's `format` is already a JSON Schema, which is exactly what OpenAI's
  // response_format.json_schema wants. Some captures put it under json_schema.
  let schema = null;
  if (parsed.format) {
    schema =
      typeof parsed.format === "object" && parsed.format.json_schema
        ? parsed.format.json_schema
        : parsed.format;
  }

  // --- generation options ----------------------------------------------
  const options = parsed.options ?? {};
  const mapped = {};
  if (options.temperature !== undefined) mapped.temperature = options.temperature;
  if (options.num_predict !== undefined) mapped.max_completion_tokens = options.num_predict;
  if (options.repeat_penalty !== undefined) {
    // No OpenAI equivalent. Groq/NVIDIA don't accept repeat_penalty, so this is
    // genuinely dropped -- say so rather than implying it is in effect.
    warnings.push(
      `options.repeat_penalty=${options.repeat_penalty} has no OpenAI-compatible ` +
        `equivalent and was dropped; sampling will not be penalised for repetition.`
    );
  }
  if (parsed.think === true) {
    warnings.push(
      `"think": true requests a reasoning pass. Neither Groq nor NVIDIA exposes ` +
        `that switch through chat completions; thinking output, if any, arrives in ` +
        `the response body and is not returned.`
    );
  }

  // --- images ----------------------------------------------------------
  const rawImages = userMessage.images ?? [];
  const referencedImages = [];
  for (const image of rawImages) {
    if (typeof image === "string" && image.startsWith("data:")) {
      referencedImages.push("(inline data URL)");
    } else {
      referencedImages.push(...extractOllamaImagePaths(image));
    }
  }

  return {
    prompt: userMessage.content,
    schema,
    options: mapped,
    warnings,
    referencedImages,
  };
}

/**
 * Converts a harness dataset item's `responseFormat` into an OpenAI
 * `response_format` object, or undefined when the dataset wants free text.
 */
export function toResponseFormat(schema) {
  if (!schema) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      // Some gateways (and Groq in particular) require an explicit `name`.
      name: "eval_response",
      strict: true,
      schema,
    },
  };
}