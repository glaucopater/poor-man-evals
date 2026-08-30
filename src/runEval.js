// Must be the first import: registers the Langfuse OTel span processor
// before any tracing calls happen.
import { langfuseSpanProcessor } from "./instrumentation.js";

import { startActiveObservation } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";

import { callGroq, listGroqModelIds } from "./groqClient.js";
import { judgeOutput, JUDGE_MODEL } from "./judge.js";
import { id as textId, dataset as textDataset } from "./datasets/text.js";
import { id as imageId, dataset as imageDataset } from "./datasets/image.js";
import { MODELS_UNDER_TEST, VISION_MODELS } from "./models.js";

const langfuse = new LangfuseClient();

/**
 * Dataset registry: maps a dataset id to the model set it should run against.
 * Text runs against all chat models; image runs only against vision models.
 */
const DATASETS = {
  [textId]: { models: MODELS_UNDER_TEST, items: textDataset },
  [imageId]: { models: VISION_MODELS, items: imageDataset },
};

/**
 * Builds the user message content for an eval item. Plain strings are sent
 * as-is; items that carry an `image` (base64 data URL) are expanded into an
 * OpenAI-style array of content parts so the model receives the pixels.
 */
function buildUserContent(item) {
  if (!item.image) return item.input;
  return [
    { type: "text", text: item.input },
    { type: "image_url", image_url: { url: item.image } },
  ];
}

/**
 * Picks the dataset to run. `npm run eval -- image`, `-- --dataset image`,
 * `--dataset=image`, or PACKAGE selection all resolve the same way. Defaults
 * to the text dataset.
 */
function resolveDataset() {
  const argv = process.argv.slice(2);
  let name = textId;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dataset") {
      name = argv[i + 1];
    } else if (arg.startsWith("--dataset=")) {
      name = arg.split("=")[1];
    } else if (!arg.startsWith("--")) {
      name = arg; // positional: `npm run eval -- image`
    }
  }
  return name;
}

/**
 * Runs a single (model, dataset item) pair inside its own Langfuse trace:
 * span -> generation (the Groq call) -> LLM-as-judge score attached to the trace.
 */
async function runOne(model, item) {
  return startActiveObservation(`eval:${model}:${item.id}`, async (span) => {
    const userMessage = { role: "user", content: buildUserContent(item) };

    span.update({
      input: { prompt: item.input },
      metadata: {
        datasetId: item.id,
        model,
        criteria: item.criteria,
        hasImage: Boolean(item.image),
      },
    });

    const generation = span.startObservation(
      "groq-completion",
      {
        model,
        input: [userMessage],
      },
      { asType: "generation" }
    );

    let output = "";
    let usage = {};

    try {
      const result = await callGroq({
        model,
        messages: [userMessage],
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
async function assertModelsAvailable(models) {
  console.log("Checking model availability against Groq...");
  const available = await listGroqModelIds();

  const requested = [...new Set([...models, JUDGE_MODEL])];
  const missing = requested.filter((id) => !available.has(id));

  if (missing.length > 0) {
    console.error(`\nThe following model id(s) are not available to your Groq API key:`);
    for (const id of missing) console.error(`  - ${id}`);
    console.error(`\nAvailable models:`);
    for (const id of [...available].sort()) console.error(`  - ${id}`);
    console.error(
      `\nFix the dataset's model list in src/models.js or JUDGE_MODEL in .env, then re-run.`
    );
    process.exit(1);
  }

  console.log("All configured models are available.\n");
}

async function main() {
  const datasetId = resolveDataset();
  const selected = DATASETS[datasetId];

  if (!selected) {
    console.error(
      `Unknown dataset "${datasetId}". Available: ${Object.keys(DATASETS).join(", ")}.`
    );
    process.exit(1);
  }

  const { models, items } = selected;

  if (models.length === 0) {
    console.error(
      `No models configured for dataset "${datasetId}". Add model ids to its list in src/models.js.`
    );
    process.exit(1);
  }

  console.log(`Dataset: ${datasetId} (${items.length} case(s), ${models.length} model(s))`);

  await assertModelsAvailable(models);

  const results = [];

  for (const model of models) {
    for (const item of items) {
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
