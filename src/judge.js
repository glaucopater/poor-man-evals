import { callModel, DEFAULT_PROVIDER } from "./providers/index.js";

export const JUDGE_PROVIDER = process.env.JUDGE_PROVIDER || DEFAULT_PROVIDER;
export const JUDGE_MODEL = process.env.JUDGE_MODEL || "openai/gpt-oss-20b";

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
  const { content } = await callModel({
    provider: JUDGE_PROVIDER,
    model: JUDGE_MODEL,
    messages: [{ role: "user", content: buildJudgePrompt(input, output, criteria) }],
    temperature: 0,
    max_completion_tokens: 300,
  });

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
