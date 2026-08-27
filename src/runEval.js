// Must be the first import: registers the Langfuse OTel span processor
// before any tracing calls happen.
import { langfuseSpanProcessor } from "./instrumentation.js";

import { startActiveObservation } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";

import { callGroq, listGroqModelIds } from "./groqClient.js";
import { judgeOutput, JUDGE_MODEL } from "./judge.js";
import { dataset } from "./datasets/text.js";
import { MODELS_UNDER_TEST } from "./models.js";

const langfuse = new LangfuseClient();

/**
 * Runs a single (model, dataset item) pair inside its own Langfuse trace:
 * span -> generation (the Groq call) -> LLM-as-judge score attached to the trace.
 */
async function runOne(model, item) {
  return startActiveObservation(`eval:${model}:${item.id}`, async (span) => {
    span.update({
      input: { prompt: item.input },
      metadata: { datasetId: item.id, model, criteria: item.criteria },
    });

    const generation = span.startObservation(
      "groq-completion",
      {
        model,
        input: [{ role: "user", content: item.input }],
      },
      { asType: "generation" }
    );

    let output = "";
    let usage = {};

    try {
      const result = await callGroq({
        model,
        messages: [{ role: "user", content: item.input }],
      });
      output = result.content;
      usage = result.usage;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      generation.update({ output: { error: message } }).end();
      span.update({ output: { error: message }, level: "ERROR" }).end();
      return { model, itemId: item.id, error: message };
    }

    generation
      .update({
        output: { content: output },
        usageDetails: {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
          total: usage.total_tokens ?? 0,
        },
      })
      .end();

    const judged = await judgeOutput({
      input: item.input,
      output,
      criteria: item.criteria,
    });

    span.update({ output: { content: output } });

    langfuse.score.create({
      traceId: span.traceId,
      name: "llm-judge-score",
      value: judged.score ?? 0,
      dataType: "NUMERIC",
      comment: judged.reasoning,
    });

    span.end();

    return { model, itemId: item.id, output, judged };
  });
}

/**
 * Fails fast if any configured model id (under test or judge) isn't
 * actually available to this Groq API key -- rather than discovering it
 * mid-run after burning some calls, or worse, silently scoring an error.
 */
async function assertModelsAvailable() {
  console.log("Checking model availability against Groq...");
  const available = await listGroqModelIds();

  const requested = [...new Set([...MODELS_UNDER_TEST, JUDGE_MODEL])];
  const missing = requested.filter((id) => !available.has(id));

  if (missing.length > 0) {
    console.error(`\nThe following model id(s) are not available to your Groq API key:`);
    for (const id of missing) console.error(`  - ${id}`);
    console.error(`\nAvailable models:`);
    for (const id of [...available].sort()) console.error(`  - ${id}`);
    console.error(
      `\nFix src/models.js (MODELS_UNDER_TEST) or JUDGE_MODEL in .env, then re-run.`
    );
    process.exit(1);
  }

  console.log("All configured models are available.\n");
}

async function main() {
  if (MODELS_UNDER_TEST.length === 0) {
    console.error("MODELS_UNDER_TEST is empty. Add at least one model id in src/models.js.");
    process.exit(1);
  }

  await assertModelsAvailable();

  const results = [];

  for (const model of MODELS_UNDER_TEST) {
    for (const item of dataset) {
      console.log(`Running ${model} on "${item.id}"...`);
      const result = await runOne(model, item);
      results.push(result);
    }
  }

  console.log("\n=== Eval Summary ===");
  for (const r of results) {
    if (r.error) {
      console.log(`[${r.model}] ${r.itemId}: ERROR - ${r.error}`);
    } else {
      console.log(`[${r.model}] ${r.itemId}: score=${r.judged.score ?? "n/a"}/5 - ${r.judged.reasoning}`);
    }
  }

  const avgByModel = {};
  for (const r of results) {
    if (r.error || r.judged.score == null) continue;
    avgByModel[r.model] ??= [];
    avgByModel[r.model].push(r.judged.score);
  }
  console.log("\n=== Average score by model ===");
  for (const [model, scores] of Object.entries(avgByModel)) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`${model}: ${avg.toFixed(2)}/5 (n=${scores.length})`);
  }

  // Flush scores and spans before the process exits.
  await langfuse.flush();
  await langfuseSpanProcessor.forceFlush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
