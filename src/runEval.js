// Must be the first import: registers the Langfuse OTel span processor
// before any tracing calls happen.
import { langfuseSpanProcessor } from "./instrumentation.js";

import { randomUUID } from "node:crypto";

import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";

import { callModel, listModelIds, normalizeModel, PROVIDERS } from "./providers.js";
import { judgeOutput, JUDGE_MODEL, JUDGE_PROVIDER } from "./judge.js";
import { id as textId, dataset as textDataset } from "./datasets/text.js";
import { id as imageId, dataset as imageDataset } from "./datasets/image.js";
import { MODELS_UNDER_TEST, VISION_MODELS } from "./models.js";

const langfuse = new LangfuseClient();

/**
 * Providers to actually run, comma-separated (e.g. `groq` or `groq,nvidia`).
 * Defaults to every known provider. Set `ENABLED_PROVIDERS=groq` in .env to
 * take a provider out of a run without deleting its entries in src/models.js.
 */
const ENABLED_PROVIDERS = new Set(
  (process.env.ENABLED_PROVIDERS ?? Object.keys(PROVIDERS).join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
);

/**
 * Dataset registry: maps a dataset id to the model set it should run against.
 * Text runs against all chat models; image runs only against vision models.
 */
const DATASETS = {
  [textId]: { models: MODELS_UNDER_TEST.map(normalizeModel), items: textDataset },
  [imageId]: { models: VISION_MODELS.map(normalizeModel), items: imageDataset },
};

/**
 * Identifier shared by every trace in this process's run, used as the Langfuse
 * session id. Because v5 propagates the session id onto each observation, one
 * run shows up as one session with correct per-session cost aggregation.
 */
function newRunId() {
  return `eval-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

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
 * Picks the dataset to run: the `eval:text` / `eval:image` package scripts, or
 * an explicit `--dataset image` / `--dataset=image` / bare positional
 * (`yarn eval image`) forwarded to `node src/runEval.js`. Defaults to text.
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
      name = arg; // positional: `yarn eval image`
    }
  }
  return name;
}

/**
 * Runs a single (model, dataset item) pair inside its own Langfuse trace.
 *
 * Langfuse v5 is observations-first: correlating attributes (trace name,
 * session, tags, metadata) are propagated to the root and to every child
 * observation rather than being stored on the trace alone. `propagateAttributes`
 * wraps the observation-producing call to establish that scope, so the
 * generation below carries the same session/tags/metadata as its root.
 * Note the propagated `metadata` must be `Record<string, string>` with values
 * <= 200 chars, which is why the (long) judging criteria live in the root
 * observation's input instead.
 */
async function runOne(model, item, run) {
  const traceName = `eval:${model.id}:${item.id}`;
  const userMessage = { role: "user", content: buildUserContent(item) };

  return propagateAttributes(
    {
      traceName,
      sessionId: run.sessionId,
      tags: [`dataset:${run.datasetId}`, `provider:${model.provider}`],
      metadata: {
        datasetId: item.id,
        model: model.id,
        provider: model.provider,
        hasImage: String(Boolean(item.image)),
      },
    },
    async () =>
      startActiveObservation(traceName, async (span) => {
        span.update({ input: { prompt: item.input, criteria: item.criteria } });

        const generation = span.startObservation(
          `${model.provider}-completion`,
          {
            model: model.id,
            input: [userMessage],
          },
          { asType: "generation" }
        );

        let output = "";
        let usage = {};

        try {
          const result = await callModel({
            provider: model.provider,
            model: model.id,
            messages: [userMessage],
          });
          output = result.content;
          usage = result.usage;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          generation.update({ output: { error: message } }).end();
          span.update({ output: { error: message }, level: "ERROR" }).end();
          return { model: model.id, provider: model.provider, itemId: item.id, error: message };
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

        // Observation-level score: the judge scores the model's generation, so
        // the score is attached to that observation (v5's default target for
        // evaluators) rather than to the trace.
        langfuse.score.observation(
          { otelSpan: generation.otelSpan },
          {
            name: "llm-judge-score",
            value: judged.score ?? 0,
            dataType: "NUMERIC",
            comment: judged.reasoning,
          }
        );

        span.end();

        return { model: model.id, provider: model.provider, itemId: item.id, output, judged };
      })
  );
}

/**
 * Fails fast if any configured model id (under test or judge) isn't
 * actually available to its provider's API key -- rather than discovering it
 * mid-run after burning some calls, or worse, silently scoring an error.
 * Only providers that are actually in use get queried.
 *
 * Listing model ids isn't sufficient proof that a key works: NVIDIA's
 * /v1/models endpoint returns 200 even with no auth at all. So we follow up
 * with a real 1-token completion probe per provider, which is what actually
 * catches a 401/403 before the run starts.
 */
async function assertModelsAvailable(models) {
  console.log("Checking model availability...");

  const byProvider = new Map();
  const add = (provider, id) => {
    if (!byProvider.has(provider)) byProvider.set(provider, new Set());
    byProvider.get(provider).add(id);
  };
  for (const m of models) add(m.provider, m.id);
  add(JUDGE_PROVIDER, JUDGE_MODEL);

  const missing = [];
  const availableByProvider = new Map();

  for (const [provider, ids] of byProvider) {
    const available = await listModelIds(provider);
    const missingIds = [...ids].filter((id) => !available.has(id));
    if (missingIds.length === 0) continue;
    availableByProvider.set(provider, available);
    for (const id of missingIds) missing.push({ provider, id });
  }

  if (missing.length > 0) {
    console.error(`\nThe following model id(s) are not available to your API key(s):`);
    for (const { provider, id } of missing) {
      console.error(`  - ${id} (${PROVIDERS[provider].label})`);
    }
    for (const [provider, available] of availableByProvider) {
      console.error(`\nAvailable ${PROVIDERS[provider].label} models:`);
      for (const id of [...available].sort()) console.error(`  - ${id}`);
    }
    console.error(
      `\nFix the dataset's model list in src/models.js or JUDGE_MODEL / JUDGE_PROVIDER in .env, then re-run.`
    );
    process.exit(1);
  }

  // Real auth probe: a tiny completion against one model per provider. Catches
  // keys that can list models but can't run inference (NVIDIA commonly does this).
  const probeFailures = [];
  for (const [provider, ids] of byProvider) {
    const sample = provider === JUDGE_PROVIDER && ids.has(JUDGE_MODEL) ? JUDGE_MODEL : [...ids][0];
    try {
      await callModel({
        provider,
        model: sample,
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
        max_completion_tokens: 32,
      });
    } catch (err) {
      probeFailures.push({ provider, model: sample, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Only auth errors are fatal; anything else (e.g. a model that dislikes tiny
  // max_tokens) should not block the whole run.
  const fatal = probeFailures.filter((p) => /\((401|403)\b/.test(p.message));
  for (const p of probeFailures.filter((p) => !fatal.includes(p))) {
    console.warn(`\nWarning: auth probe on ${p.provider} ("${p.model}") failed: ${p.message}`);
  }

  if (fatal.length > 0) {
    console.error(`\nAuthentication probe failed -- the key cannot run inference:`);
    for (const p of fatal) {
      console.error(`\n  ${PROVIDERS[p.provider].label} (probed "${p.model}"):`);
      console.error(`  ${p.message}`);
    }
    console.error(`\nFix the provider's API key/permissions, then re-run.`);
    process.exit(1);
  }

  console.log("All configured models are available and reachable.\n");
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

  for (const name of ENABLED_PROVIDERS) {
    if (!PROVIDERS[name]) {
      console.error(
        `Unknown provider "${name}" in ENABLED_PROVIDERS. Known providers: ${Object.keys(PROVIDERS).join(", ")}.`
      );
      process.exit(1);
    }
  }

  const allModels = selected.models;
  const models = allModels.filter((m) => ENABLED_PROVIDERS.has(m.provider));

  const skipped = [...new Set(allModels.filter((m) => !ENABLED_PROVIDERS.has(m.provider)).map((m) => m.provider))];
  if (skipped.length > 0) {
    console.log(`Skipping disabled provider(s): ${skipped.join(", ")} (ENABLED_PROVIDERS).`);
  }

  const { items } = selected;

  if (models.length === 0) {
    console.error(
      `No models to run for dataset "${datasetId}". Either add model ids to its list in src/models.js, ` +
        `or widen ENABLED_PROVIDERS (currently: ${[...ENABLED_PROVIDERS].join(", ")}).`
    );
    process.exit(1);
  }

  const providers = [...new Set(models.map((m) => m.provider))].join(", ");
  const run = { sessionId: newRunId(), datasetId };
  console.log(
    `Dataset: ${datasetId} (${items.length} case(s), ${models.length} model(s) via ${providers})`
  );
  console.log(`Langfuse session: ${run.sessionId}`);

  await assertModelsAvailable(models);

  const results = [];

  for (const model of models) {
    for (const item of items) {
      console.log(`Running ${model.id} (${model.provider}) on "${item.id}"...`);
      const result = await runOne(model, item, run);
      results.push(result);
    }
  }

  console.log("\n=== Eval Summary ===");
  for (const r of results) {
    const label = `${r.model} (${r.provider})`;
    if (r.error) {
      console.log(`[${label}] ${r.itemId}: ERROR - ${r.error}`);
    } else {
      console.log(
        `[${label}] ${r.itemId}: score=${r.judged.score ?? "n/a"}/5 - ${r.judged.reasoning}`
      );
    }
  }

  const avgByModel = {};
  for (const r of results) {
    if (r.error || r.judged.score == null) continue;
    // Key on id + provider so the same model id served by two providers stays distinct.
    const key = `${r.model} (${r.provider})`;
    avgByModel[key] ??= [];
    avgByModel[key].push(r.judged.score);
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
