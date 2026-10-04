/**
 * Loading images from disk.
 *
 * The existing datasets inline their base64 as a giant string literal in JS.
 * That is fine for a 20 KB test pattern, but a real photo (a 1920x1080 JPEG is
 * ~548 KB, ~731 KB once base64-encoded) turns the dataset file into an
 * unreadable wall of characters and gets reviewed badly by git. Reading the
 * binary at runtime keeps the dataset declarative and the diff meaningful.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/images.js -> repo root. Relative dataset paths resolve against this, not
// against process.cwd(), so `yarn eval` behaves the same from any directory.
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

/** Repo root, exported so datasets can resolve their own asset paths. */
export { REPO_ROOT };

/**
 * Maps a file path to the MIME type that belongs in a data URL. Falls back to
 * `application/octet-stream`, which makes provider-side rejection obvious
 * rather than mysterious.
 */
export function mimeTypeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Resolves a dataset-relative path to an absolute one. */
export function resolveAssetPath(imagePath) {
  const candidates = isAbsolute(imagePath)
    ? [imagePath]
    : [resolve(REPO_ROOT, imagePath), resolve(process.cwd(), imagePath)];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Image not found: ${imagePath}. Tried:\n` + candidates.map((c) => `  - ${c}`).join("\n")
  );
}

/**
 * Reads an image file and returns it as a base64 data URL.
 *
 * The returned string is exactly what the OpenAI-compatible `image_url` part
 * expects, and is what `content.js` / Langfuse's media upload already know how
 * to handle.
 *
 * @param {string} imagePath - repo-relative or absolute path to the image.
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] - refuse files larger than this. Most
 *   OpenAI-compatible gateways cap request bodies (Groq and NVIDIA both reject
 *   oversized multimodal requests), and the resulting error is usually opaque.
 * @returns {string} e.g. `data:image/jpeg;base64,/9j/4AAQ...`
 */
export function imageDataUrl(imagePath, { maxBytes } = {}) {
  const absolute = resolveAssetPath(imagePath);
  const { size } = statSync(absolute);

  if (maxBytes && size > maxBytes) {
    throw new Error(
      `Image ${imagePath} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(maxBytes / 1024 / 1024).toFixed(1)} MB limit. Base64 inflates it by ~33%, ` +
        `so resize or compress it before the eval (the harness does not resize).`
    );
  }

  const buffer = readFileSync(absolute);
  return `data:${mimeTypeFor(absolute)};base64,${buffer.toString("base64")}`;
}

/**
 * True when the value is already a data URL, so datasets can accept either an
 * inline base64 string or a file path without special-casing.
 */
export function isDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:");
}

/**
 * Normalizes an `image` field from a dataset item into a data URL: passes data
 * URLs through untouched, reads anything else from disk.
 */
export function toDataUrl(image, opts) {
  if (isDataUrl(image)) return image;
  if (typeof image === "string") return imageDataUrl(image, opts);
  throw new Error(`Unsupported image value: expected a path or data URL, got ${typeof image}`);
}

/** Human-readable byte size, for logging what a request actually costs. */
export function describeDataUrl(dataUrl) {
  const base64Length = dataUrl.length - dataUrl.indexOf(",") - 1;
  const bytes = Math.floor((base64Length * 3) / 4);
  return `${(bytes / 1024).toFixed(0)} KB`;
}