import { callGroq } from "./groqClient.js";

export const JUDGE_MODEL = process.env.JUDGE_MODEL || "canopylabs/orpheus-v1-english";

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
 * @param {object} params
 * @param {string} params.input - the original prompt
 * @param {string} params.output - the model's response
 * @param {string} params.criteria - what a good response looks like
 * @returns {Promise<{score: number|null, reasoning: string}>}
 */
export async function judgeOutput({ input, output, criteria }) {
  const { content } = await callGroq({
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
