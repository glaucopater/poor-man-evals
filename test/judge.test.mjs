import "./helpers/env.mjs"; // must come first: sets env the clients read at import time

import { test } from "node:test";
import assert from "node:assert/strict";

import { judgeOutput, buildJudgeScore } from "../src/judge.js";
import { normalizeCompletionContent } from "../src/providers/content.js";

/**
 * Stubs global fetch so the judge never bills a real provider.
 *
 * @param {string} assistantContent - what the provider puts in message.content
 * @param {object} [opts] - `status` for an error response, `envelope: false` to
 *   return the raw string instead of a chat-completions body.
 */
function stubJudgeResponse(assistantContent, { status = 200, envelope = true } = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), payload: options.body ? JSON.parse(options.body) : null });
    const body = envelope
      ? JSON.stringify({
          choices: [{ message: { content: assistantContent } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      : assistantContent;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const ARGS = { input: "What is the capital of France?", output: "Paris.", criteria: "Must say Paris." };

// ------------------------------------------------------------------ judgeOutput

test("judgeOutput: parses a clean JSON verdict", async () => {
  const stub = stubJudgeResponse(JSON.stringify({ score: 5, reasoning: "Correct." }));
  try {
    assert.deepEqual(await judgeOutput(ARGS), { score: 5, reasoning: "Correct." });
  } finally {
    stub.restore();
  }
});

test("judgeOutput: strips markdown fences around the JSON", async () => {
  const stub = stubJudgeResponse('```json\n{"score": 4, "reasoning": "Close."}\n```');
  try {
    const judged = await judgeOutput(ARGS);
    assert.equal(judged.score, 4);
    assert.equal(judged.reasoning, "Close.");
  } finally {
    stub.restore();
  }
});

test("judgeOutput: returns score null on unparseable output instead of throwing", async () => {
  const stub = stubJudgeResponse("I think it's pretty good actually.");
  try {
    const judged = await judgeOutput(ARGS);
    assert.equal(judged.score, null);
    assert.match(judged.reasoning, /Failed to parse judge output/);
  } finally {
    stub.restore();
  }
});

test("judgeOutput: returns score null when the score is not a finite number", async () => {
  const stub = stubJudgeResponse('{"score": "excellent", "reasoning": "..."}');
  try {
    assert.equal((await judgeOutput(ARGS)).score, null);
  } finally {
    stub.restore();
  }
});

test("judgeOutput: propagates judge call failures so callers can mark the item unscored", async () => {
  const stub = stubJudgeResponse("nope", { status: 500, envelope: false });
  try {
    await assert.rejects(() => judgeOutput(ARGS), /Groq API error \(500/);
  } finally {
    stub.restore();
  }
});

test("judgeOutput: sends the judge prompt as a deterministic, short completion", async () => {
  const stub = stubJudgeResponse(JSON.stringify({ score: 3, reasoning: "Partial." }));
  try {
    await judgeOutput(ARGS);
    const body = stub.calls[0].payload;
    assert.equal(body.temperature, 0);
    assert.ok(body.max_completion_tokens <= 512, "judge output must stay small");
    assert.match(body.messages[0].content, /impartial evaluator/);
    assert.match(body.messages[0].content, /Paris/);
  } finally {
    stub.restore();
  }
});

// --------------------------------------------------------------- buildJudgeScore

test("buildJudgeScore: a real score becomes a NUMERIC llm-judge-score", () => {
  const score = buildJudgeScore({ score: 4, reasoning: "Mostly right." });
  assert.deepEqual(score, {
    name: "llm-judge-score",
    value: 4,
    dataType: "NUMERIC",
    comment: "Mostly right.",
  });
});

test("buildJudgeScore: an unscored judge result is NEVER coerced to 0", () => {
  // The bug this guards: `judged.score ?? 0` wrote 0 for parse failures, which
  // is indistinguishable from a bad model answer in both Langfuse and the
  // harness average.
  const score = buildJudgeScore({ score: null, reasoning: "Failed to parse judge output." });
  assert.equal(score.name, "llm-judge-error");
  assert.equal(score.dataType, "CATEGORICAL");
  assert.notEqual(score.value, 0);
  assert.match(score.comment, /Failed to parse judge output/);
});

test("buildJudgeScore: distinguishes an out-of-range score as unscored, not as a number", () => {
  assert.equal(buildJudgeScore({ score: 9, reasoning: "" }).value, 9);
  assert.equal(buildJudgeScore({ score: NaN, reasoning: "nan" }).name, "llm-judge-error");
});

// -------------------------------------------------------- normalizeCompletionContent

test("normalizeCompletionContent: plain string passes through", () => {
  assert.equal(normalizeCompletionContent({ choices: [{ message: { content: "hi" } }] }), "hi");
});

test("normalizeCompletionContent: joins array content parts", () => {
  const data = {
    choices: [
      { message: { content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] } },
    ],
  };
  assert.equal(normalizeCompletionContent(data), "part one part two");
});

test("normalizeCompletionContent: falls back to reasoning fields when content is empty", () => {
  assert.equal(
    normalizeCompletionContent({ choices: [{ message: { content: null, reasoning_content: "thought" } }] }),
    "thought"
  );
  assert.equal(
    normalizeCompletionContent({ choices: [{ message: { content: "", reasoning: "more thought" } }] }),
    "more thought"
  );
});

test("normalizeCompletionContent: missing/empty responses become an empty string", () => {
  assert.equal(normalizeCompletionContent({ choices: [] }), "");
  assert.equal(normalizeCompletionContent({}), "");
  assert.equal(normalizeCompletionContent({ choices: [{ message: {} }] }), "");
});