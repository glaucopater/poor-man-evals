/**
 * Console formatting helpers for the eval run.
 *
 * Kept out of runEval.js because that module executes `main()` on import, so
 * anything defined there cannot be unit tested without kicking off a real eval.
 */

import { providerTag } from "./providers/index.js";

/**
 * Human-readable duration: "820ms", "12.4s", "3m 12s".
 *
 * Reads as "how long did I wait" rather than a precision claim, which is why
 * milliseconds are rounded to whole units instead of shown to 3 decimal places.
 *
 * @param {number|null|undefined} ms
 * @returns {string|null} null for unknown timings, so callers can omit them.
 */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * The per-item result line, printed as soon as an item finishes.
 *
 * @param {object} result - a runOne result, plus `elapsedMs`.
 * @returns {string}
 */
export function formatItemOutcome(result) {
  const parts = [];

  const elapsed = formatDuration(result.elapsedMs);
  if (elapsed) parts.push(elapsed);

  // Only Ollama reports a phase breakdown, and it explains an otherwise baffling
  // first-item delay: the model load (reading weights into VRAM), which is a
  // one-off per model rather than a per-request cost.
  const t = result.timings;
  if (t?.loadMs) {
    const phases = [`load ${formatDuration(t.loadMs)}`];
    if (t.evalMs) phases.push(`generate ${formatDuration(t.evalMs)}`);
    parts.push(`(${phases.join(", ")})`);
  }

  if (result.usage?.total_tokens) {
    parts.push(`${result.usage.prompt_tokens} in / ${result.usage.completion_tokens} out tok`);
  }

  if (result.schemaScore) parts.push(`schema ${result.schemaScore.value ? "ok" : "FAILED"}`);
  if (result.truncated === true) parts.push("TRUNCATED");
  if (result.error) parts.push("ERROR");
  else if (!Number.isFinite(result.judged?.score)) parts.push("unscored");
  else parts.push(`judge ${result.judged.score}/5`);

  return parts.join(" · ");
}

/**
 * Rough remaining time, from the mean of completed items.
 *
 * Deliberately prefixed "~": item cost varies by an order of magnitude between a
 * 2B and a 27B model, so this is a sanity check that progress is being made, not
 * a promise. With one item done it is pure guesswork, so it is only shown once
 * there is at least one sample.
 *
 * @returns {string|null}
 */
export function formatEta(completed, remaining, meanMs) {
  if (remaining <= 0 || completed <= 0 || !Number.isFinite(meanMs)) return null;
  const eta = formatDuration(meanMs * remaining);
  return eta ? `   (~${eta} left)` : null;
}

/**
 * Per-model wall-clock and token totals for the end-of-run table.
 *
 * Total tokens are the only cost proxy that works for a local run too, where
 * there is no bill to check afterwards.
 *
 * @param {Array<object>} results - results carrying `elapsedMs`.
 * @returns {Array<{key: string, ms: number, in: number, out: number, n: number, slowest: number}>}
 */
export function summarizeTimings(results) {
  const byModel = new Map();
  for (const r of results) {
    if (r.elapsedMs == null) continue;
    const key = `${r.model} (${providerTag(r.provider)})`;
    const entry = byModel.get(key) ?? { key, ms: 0, in: 0, out: 0, n: 0, slowest: 0 };
    entry.ms += r.elapsedMs;
    entry.in += r.usage?.prompt_tokens ?? 0;
    entry.out += r.usage?.completion_tokens ?? 0;
    entry.n += 1;
    entry.slowest = Math.max(entry.slowest, r.elapsedMs);
    byModel.set(key, entry);
  }
  return [...byModel.values()];
}