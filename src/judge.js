import { callModel, DEFAULT_PROVIDER, providersSupporting } from "./providers/index.js";

export const JUDGE_PROVIDER = process.env.JUDGE_PROVIDER || DEFAULT_PROVIDER;
export const JUDGE_MODEL = process.env.JUDGE_MODEL || "openai/gpt-oss-20b";

/**
 * Output budget for one verdict.
 *
 * This was 300, which is only enough for a model that answers immediately. A
 * reasoning model spends its whole budget thinking out loud and is then cut off
 * before it emits the verdict -- a truncated response is not parseable JSON, so
 * the item silently scored as UNSCORED. Measured on local Ollama with the real
 * judge prompt: gemma4:12b burned all 300 tokens and produced nothing usable.
 * 512 is comfortable headroom for the ~40-150 token verdict a judge actually
 * needs once thinking is suppressed (see JUDGE_THINK below).
 */
export const JUDGE_MAX_COMPLETION_TOKENS = Number(process.env.JUDGE_MAX_COMPLETION_TOKENS ?? 512);

/**
 * Whether to let the judge think before answering.
 *
 * A judge needs a terse verdict, not a chain of reasoning -- the reasoning is
 * invisible to the reader and burns the output budget. Measured on local Ollama
 * with the real judge prompt and the same 1000-token budget:
 *
 *   gemma4:12b   thinking on  -> 1000 tokens, still unparseable
 *   gemma4:12b   thinking off -> 39 tokens, valid verdict
 *   qwen3.8:27b  thinking on  ->  845 tokens, valid verdict
 *   qwen3.8:27b  thinking off ->  62 tokens, valid verdict
 *
 * Only sent to providers that implement the switch (today: Ollama); the others
 * have no such control. Override with JUDGE_THINK=true if you have a judge that
 * genuinely reasons better out loud -- at the cost of a larger budget and
 * slower verdicts.
 */
const JUDGE_THINK = process.env.JUDGE_THINK ? process.env.JUDGE_THINK === "true" : false;
const JUDGE_SUPPORTS_THINK = providersSupporting("think").includes(JUDGE_PROVIDER);

const buildJudgePrompt = (input, output, criteria) => `You are a strict, impartial evaluator of LLM outputs.

Task given to the model:
"""
${input}
"""

Model's response:
"""
${output}
"""

Evaluation criteria:
"""
${criteria}
"""

Score the response from 1 to 5, where:
1 = completely fails the criteria
2 = mostly fails, minor redeeming qualities
3 = partially meets the criteria
4 = mostly meets the criteria, minor issues
5 = fully meets the criteria

Respond with ONLY a JSON object, no markdown fences, no extra text, in exactly this shape:
{"score": <integer 1-5>, "reasoning": "<one or two sentence explanation>"}`;

/**
 * Runs an LLM-as-judge scoring pass over a single model output.
 *
 * Throws if the judge call itself fails (network error, exhausted retries);
 * callers are expected to handle that as an *unscored* result rather than
 * treating it as a score of 0. Parse failures are handled here and returned as
 * `{ score: null }`.
 *
 * @param {object} params
 * @param {string} params.input - the original prompt
 * @param {string} params.output - the model's response
 * @param {string} params.criteria - what a good response looks like
 * @returns {Promise<{score: number|null, reasoning: string}>}
 */
export async function judgeOutput({ input, output, criteria }) {
  const { content, truncated } = await callModel({
    provider: JUDGE_PROVIDER,
    model: JUDGE_MODEL,
    messages: [{ role: "user", content: buildJudgePrompt(input, output, criteria) }],
    temperature: 0,
    max_completion_tokens: JUDGE_MAX_COMPLETION_TOKENS,
    ...(JUDGE_SUPPORTS_THINK ? { think: JUDGE_THINK } : {}),
  });

  // Distinguish "the judge said something unparseable" from "the judge ran out
  // of budget", which have completely different fixes (a stricter prompt vs. a
  // larger JUDGE_MAX_COMPLETION_TOKENS) and otherwise look identical.
  if (truncated) {
    return {
      score: null,
      reasoning:
        `Judge response was truncated at ${JUDGE_MAX_COMPLETION_TOKENS} tokens before it ` +
        `finished, so no verdict could be read. Raise JUDGE_MAX_COMPLETION_TOKENS, or set ` +
        `JUDGE_THINK=false if the judge is reasoning out loud. Raw: ${content}`,
    };
  }

  try {
    const cleaned = content
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    const score = Number(parsed.score);

    if (!Number.isFinite(score)) {
      throw new Error("score is not a finite number");
    }

    return { score, reasoning: parsed.reasoning ?? "" };
  } catch (err) {
    return {
      score: null,
      reasoning: `Failed to parse judge output (${err.message}). Raw: ${content}`,
    };
  }
}

/**
 * Builds the Langfuse score payload for a judge result.
 *
 * A judge that could not produce a score (bad JSON, call failure) is reported
 * under its own categorical score name instead of being coerced to `0`. Writing
 * 0 would be actively misleading: it is indistinguishable from a genuinely
 * terrible model output in both the Langfuse Scores view and this harness's
 * own average, quietly dragging a model's mean down for a harness-side reason.
 *
 * @param {{score: number|null, reasoning: string}} judged
 * @returns {{name: string, value: number|string, dataType: string, comment?: string}}
 */
export function buildJudgeScore(judged) {
  // Number.isFinite, not `== null`: NaN == null is false, so a non-numeric score
  // would otherwise be written as a NUMERIC value.
  if (!Number.isFinite(judged.score)) {
    // Langfuse categorical values are short; keep the raw dump in the comment.
    return {
      name: "llm-judge-error",
      value: "unscored",
      dataType: "CATEGORICAL",
      comment: judged.reasoning,
    };
  }
  return {
    name: "llm-judge-score",
    value: judged.score,
    dataType: "NUMERIC",
    comment: judged.reasoning,
  };
}
