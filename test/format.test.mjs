import "./helpers/env.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatDuration, formatItemOutcome, formatEta, summarizeTimings } from "../src/format.js";

// ------------------------------------------------------------ formatDuration

test("formatDuration: picks a readable unit per magnitude", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(820), "820ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1.0s");
  assert.equal(formatDuration(12_400), "12.4s");
  assert.equal(formatDuration(59_900), "59.9s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(192_000), "3m 12s");
  assert.equal(formatDuration(120_000), "2m"); // rounds the remainder away
});

test("formatDuration: unknown timings return null so callers can omit them", () => {
  // A literal "unknown" in a table column is worse than an absent segment.
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(formatDuration(NaN), null);
  assert.equal(formatDuration(Infinity), null);
});

// ---------------------------------------------------------- formatItemOutcome

test("formatItemOutcome: reports time, phases, tokens and the judge verdict", () => {
  const line = formatItemOutcome({
    model: "qwen3-vl:2b",
    provider: "ollama",
    itemId: "taiji-frame-1",
    elapsedMs: 53_300,
    timings: { loadMs: 4200, evalMs: 35_300 },
    usage: { prompt_tokens: 2338, completion_tokens: 5854, total_tokens: 8192 },
    schemaScore: { value: 1 },
    judged: { score: 4 },
  });

  assert.match(line, /^53\.3s /);
  assert.match(line, /\(load 4\.2s, generate 35\.3s\)/);
  assert.match(line, /2338 in \/ 5854 out tok/);
  assert.match(line, /schema ok/);
  assert.match(line, /judge 4\/5/);
  assert.doesNotMatch(line, /TRUNCATED/);
});

test("formatItemOutcome: surfaces a truncated response and a failed schema", () => {
  // Both must be visible on the same line: a truncated response is the usual
  // reason the schema failed, and that is a config problem, not a bad model.
  const line = formatItemOutcome({
    elapsedMs: 31_000,
    schemaScore: { value: 0 },
    truncated: true,
    judged: { score: null },
  });
  assert.match(line, /schema FAILED/);
  assert.match(line, /TRUNCATED/);
  assert.match(line, /judge 1\/5|unscored/);
});

test("formatItemOutcome: distinguishes error, unscored and untruncated", () => {
  assert.match(formatItemOutcome({ elapsedMs: 100, error: "boom" }), /ERROR/);
  assert.match(formatItemOutcome({ elapsedMs: 100, judged: { score: null } }), /unscored/);
  assert.match(formatItemOutcome({ elapsedMs: 100, judged: { score: null }, truncated: false }), /unscored/);
  assert.doesNotMatch(formatItemOutcome({ elapsedMs: 100, truncated: false }), /TRUNCATED/);
});

test("formatItemOutcome: omits phases and tokens when the provider lacks them", () => {
  // Groq and NVIDIA report no phase breakdown, so those segments must vanish
  // rather than render as empty parens or "0 tok".
  const line = formatItemOutcome({
    elapsedMs: 2400,
    usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 },
    judged: { score: 3 },
  });
  assert.equal(line, "2.4s · 120 in / 340 out tok · judge 3/5");
});

test("formatItemOutcome: a result with no timing, tokens or scores still reports something", () => {
  // Unreachable via runOne (every result has either `judged` or `error`), but a
  // formatter must never throw or render an empty progress line. With no judged
  // verdict present, "unscored" is the honest reading.
  const line = formatItemOutcome({});
  assert.equal(line, "unscored");
  assert.doesNotMatch(line, /undefined|NaN|null/);
});

// --------------------------------------------------------------- formatEta

test("formatEta: is withheld until there is something to extrapolate from", () => {
  assert.equal(formatEta(0, 6, 1000), null, "no samples yet");
  assert.equal(formatEta(3, 0, 1000), null, "nothing left");
  assert.equal(formatEta(3, 2, NaN), null);
  assert.match(formatEta(1, 5, 1000), /~5\.0s left/);
});

test("formatEta: is explicitly approximate", () => {
  // Item cost varies by an order of magnitude between a 2B and a 27B model, so
  // this must never read as a promise.
  assert.match(formatEta(2, 4, 30_000), /~2m/);
});

// ---------------------------------------------------------- summarizeTimings

test("summarizeTimings: aggregates per model and finds the slowest item", () => {
  const rows = summarizeTimings([
    { model: "a", provider: "ollama", elapsedMs: 1000, usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { model: "a", provider: "ollama", elapsedMs: 3000, usage: { prompt_tokens: 10, completion_tokens: 7 } },
    { model: "b", provider: "ollama", elapsedMs: 2000 },
    { model: "c", provider: "ollama" }, // no elapsedMs: must be skipped
  ]);

  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.key.startsWith("a"));
  assert.equal(a.ms, 4000);
  assert.equal(a.slowest, 3000);
  assert.equal(a.n, 2);
  assert.equal(a.out, 12);

  const b = rows.find((r) => r.key.startsWith("b"));
  assert.equal(b.out, 0, "missing usage counts as zero, not NaN");
  assert.equal(Number.isNaN(b.out), false);
});

test("summarizeTimings: keys on provider tag so local and remote stay distinct", () => {
  const rows = summarizeTimings([
    { model: "m", provider: "ollama", elapsedMs: 1000 },
    { model: "m", provider: "groq", elapsedMs: 1000 },
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.key.includes("ollama/local")));
  assert.ok(rows.some((r) => r.key.includes("groq")));
});

test("summarizeTimings: returns nothing when no result carries a duration", () => {
  assert.deepEqual(summarizeTimings([{ model: "a" }, {}]), []);
});