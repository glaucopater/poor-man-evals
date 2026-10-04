// Must be the first import: resolves eval.config.yaml, validates it, and
// projects the result into process.env. Everything below reads process.env, and
// so does the Langfuse SDK, so this has to happen before any of them load.
import "./config.js";

// Must be imported before anything else that creates spans: registers the
// Langfuse OTel span processor with the Node SDK.
import { langfuseSpanProcessor } from "./instrumentation.js";

import { config, profile, configSource } from "./config.js";

import { randomUUID } from "node:crypto";

import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";

import { callModel, listModelIds, normalizeModel, PROVIDERS } from "./providers/index.js";
import { judgeOutput, buildJudgeScore, JUDGE_MODEL, JUDGE_PROVIDER } from "./judge.js";
import { id as textId, dataset as textDataset } from "./datasets/text.js";
import { id as imageId, dataset as imageDataset } from "./datasets/image.js";
import {
  id as complexImageId,
  dataset as complexImageDataset,
  notes as complexImageNotes,
} from "./datasets/complex-image.js";
import { scoreAgainstSchema } from "./jsonSchema.js";
import {
  CHAT_MODELS,
  VISION_MODELS_ALL,
} from "./models.js";

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
  [textId]: { models: CHAT_MODELS.map(normalizeModel), items: textDataset },
  [imageId]: { models: VISION_MODELS_ALL.map(normalizeModel), items: imageDataset },
  [complexImageId]: {
    // Local models first: they are free and fast, so the run gives you signal
    // before the hosted (billed, rate-limited) models get to it.
    models: VISION_MODELS_ALL.map(normalizeModel),
    items: complexImageDataset,
    notes: complexImageNotes,
  },
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
 * as-is; items that carry an `image` (a base64 data URL, either inlined or read
 * from disk at load time) are expanded into an OpenAI-style array of content
 * parts so the model receives the pixels.
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
    if (arg === "--profile") {
      i++; // value is consumed by config.js
      continue;
    }
    if (arg === "--dataset") {
      const value = argv[i + 1];
      // Catch a missing value here rather than letting `name` become undefined
      // and reporting the confusing `Unknown dataset "undefined"`.
      if (value === undefined || value.startsWith("--")) {
        console.error(
          `--dataset requires a value. Available: ${Object.keys(DATASETS).join(", ")}.`
        );
        process.exit(1);
      }
      name = value;
      i++; // consume the value so it is not re-read as a positional
    } else if (arg.startsWith("--dataset=")) {
      name = arg.slice("--dataset=".length);
    } else if (!arg.startsWith("--")) {
      name = arg; // positional: `yarn eval image`
    }
  }
  if (name === undefined || name === "") {
    console.error(
      `--dataset requires a value. Available: ${Object.keys(DATASETS).join(", ")}.`
    );
    process.exit(1);
  }
  return name;
}

/**
 * Scores one model output, converting a judge *call* failure into an unscored
 * result.
 *
 * A judge failure (429 after retries, dropped connection) used to reject out of
 * `runOne` and abort the whole process from `main()` -- discarding every span
 * already produced, because `flush()` never ran. The model under test did its
 * job in that case; only the scorer failed, so the run should continue and
 * report the item as unscored.
 */
async function runJudge({ input, output, criteria }) {
  try {
    return await judgeOutput({ input, output, criteria });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { score: null, reasoning: `Judge call failed: ${message}`, judgeFailed: true };
  }
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
        // Providers that can report an unfinished generation set this; null means
        // the provider doesn't tell us. Ollama clamps num_predict to the context
        // window, so a truncated structured response is a real failure mode.
        let truncated = null;
        let doneReason = null;

        try {
          const result = await callModel({
            provider: model.provider,
            model: model.id,
            messages: [userMessage],
            // Per-item generation options (temperature, max tokens) and
            // structured-output spec, when the dataset supplies them. Datasets
            // without these keep the client defaults.
            ...(item.options ?? {}),
            ...(item.responseFormat ? { response_format: item.responseFormat } : {}),
          });
          output = result.content;
          usage = result.usage;
          if ("truncated" in result) truncated = result.truncated;
          if ("doneReason" in result) doneReason = result.doneReason;
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

        const judged = await runJudge({ input: item.input, output, criteria: item.criteria });

        // Only touch the level when something went wrong, so a healthy trace's
        // payload is unchanged.
        span.update({
          output: { content: output },
          ...(judged.judgeFailed ? { level: "WARNING" } : {}),
        });

        // Observation-level score: the judge scores the model's generation, so
        // the score is attached to that observation (v5's default target for
        // evaluators) rather than to the trace. An unscorable judge result is
        // written under a different score name -- never as a 0, which would be
        // indistinguishable from a bad model answer.
        const score = buildJudgeScore(judged);
        langfuse.score.observation({ otelSpan: generation.otelSpan }, score);

        // Deterministic scorer, when the item declares a schema. An LLM judge
        // is the wrong instrument for "are the braces right and is every
        // required field present" -- it reads prose and hands out 4/5 to a
        // malformed object. This is exact, free and reproducible, so it runs
        // alongside the judge rather than instead of it.
        let schemaScore = null;
        if (item.scoreSchema) {
          schemaScore = scoreAgainstSchema(output, item.scoreSchema);
          langfuse.score.observation(
            { otelSpan: generation.otelSpan },
            {
              name: "json-schema-valid",
              value: schemaScore.value,
              dataType: "NUMERIC",
              comment: schemaScore.comment,
            }
          );
        }

        // Truncation is recorded separately from the scores above: a cut-off
        // response is not "a wrong answer", it is an unusable one, and lumping it
        // in would blame the model for a context-window configuration problem.
        if (truncated !== null) {
          langfuse.score.observation(
            { otelSpan: generation.otelSpan },
            {
              name: "response-truncated",
              value: truncated ? 1 : 0,
              dataType: "NUMERIC",
              comment: truncated
                ? `Provider stopped generation early (done_reason: ${doneReason ?? "length"}). ` +
                    `The output is incomplete -- raise the context window or lower num_predict.`
                : `Provider finished normally (done_reason: ${doneReason ?? "stop"}).`,
            }
          );
        }

        span.update({
          output: { content: output },
          ...(judged.judgeFailed ? { level: "WARNING" } : {}),
          ...(truncated ? { level: "WARNING" } : {}),
        });

        span.end();

        return {
          model: model.id,
          provider: model.provider,
          itemId: item.id,
          output,
          judged,
          schemaScore,
          truncated,
        };
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
async function assertModelsAvailable(models, { requiresVision = false } = {}) {
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

  // Local runtimes can report per-model capabilities, which lets us catch a
  // text-only model before it silently ignores the image and gets graded as if
  // it had looked. Only providers exposing the optional lister are checked.
  if (requiresVision) {
    for (const provider of new Set(models.map((m) => m.provider))) {
      const detailsFn = PROVIDERS[provider]?.listModelDetails;
      if (!detailsFn) continue;
      try {
        const available = await detailsFn();
        for (const model of models.filter((m) => m.provider === provider)) {
          const info = available.find((d) => d.id === model.id);
          if (info && !info.vision) {
            console.error(
              `\n  - ${model.id} (${PROVIDERS[provider].label}) is not vision-capable, ` +
                `but this dataset sends it an image. It will ignore the image and be ` +
                `graded on the prompt alone. Remove it, or pull a vision model.`
            );
          }
        }
      } catch {
        /* capability reporting is a nicety; never fail the run over it */
      }
    }
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

  // Dataset-level diagnostics (e.g. options that could not be mapped onto the
  // provider API) surface here rather than at import time, so a dataset you
  // didn't select stays quiet.
  for (const note of selected.notes ?? []) {
    console.log(`Note [${datasetId}]: ${note}`);
  }

  if (models.length === 0) {
    // Name the actual cause rather than suggesting only "widen
    // ENABLED_PROVIDERS", which is wrong when the dataset simply has no models
    // for any enabled provider -- the usual cause of hitting this under a local
    // profile, where every entry in the list belongs to a hosted provider.
    const listProviders = [...new Set(allModels.map((m) => m.provider))].sort();
    console.error(`\nNo models to run for dataset "${datasetId}".\n`);
    console.error(
      `  The dataset lists ${allModels.length} model(s), all on: ${listProviders.join(", ")}`
    );
    console.error(`  Enabled providers are: ${[...ENABLED_PROVIDERS].join(", ")}\n`);
    console.error(`  To fix, either:`);
    console.error(
      `    - run a different profile:  yarn eval --profile hosted`
    );
    console.error(
      `    - widen the config:           run.enabled_providers in eval.config.yaml`
    );
    console.error(
      `    - add models for the enabled provider(s) in src/models.js` +
        (listProviders.includes("ollama")
          ? ""
          : `\n      (there are currently no "${[...ENABLED_PROVIDERS][0]}" models in that list)`)
    );
    process.exit(1);
  }

  const providers = [...new Set(models.map((m) => m.provider))].join(", ");
  const run = { sessionId: newRunId(), datasetId };
  console.log(`Config: ${profile === "default" ? "defaults" : `profile "${profile}"`} (${configSource})`);
  console.log(
    `Dataset: ${datasetId} (${items.length} case(s), ${models.length} model(s) via ${providers})`
  );
  console.log(`Judge: ${config.judge.model} (${config.judge.provider})`);
  console.log(`Langfuse session: ${run.sessionId}`);

  await assertModelsAvailable(models, { requiresVision: items.some((item) => item.image) });

  const results = [];

  for (const model of models) {
    for (const item of items) {
      console.log(`Running ${model.id} (${model.provider}) on "${item.id}"...`);
      // runOne already handles model-call and judge-call failures per item.
      // This is the last line of defence: an unexpected throw (a Langfuse bug,
      // a bad payload) must not abort the remaining 50-odd runs with every span
      // still buffered in memory.
      try {
        results.push(await runOne(model, item, run));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Unexpected failure on "${item.id}": ${message}`);
        results.push({ model: model.id, provider: model.provider, itemId: item.id, error: message });
      }
    }
  }

  console.log("\n=== Eval Summary ===");
  for (const r of results) {
    const label = `[${r.model} (${r.provider})]`;
    if (r.error) {
      console.log(`${label} ${r.itemId}: ERROR - ${r.error}`);
    } else if (!Number.isFinite(r.judged.score)) {
      console.log(`${label} ${r.itemId}: UNSCORED - ${r.judged.reasoning}`);
    } else {
      console.log(`${label} ${r.itemId}: score=${r.judged.score}/5 - ${r.judged.reasoning}`);
    }
  }

  const avgByModel = {};
  let unscored = 0;
  for (const r of results) {
    if (r.error) continue;
    // Report unscored items rather than silently dropping them: a judge that
    // failed on 8 of 12 cases must not look like a model that scored cleanly.
    if (!Number.isFinite(r.judged.score)) {
      unscored++;
      continue;
    }
    // Key on id + provider so the same model id served by two providers stays distinct.
    const key = `${r.model} (${r.provider})`;
    avgByModel[key] ??= [];
    avgByModel[key].push(r.judged.score);
  }
  const averages = Object.entries(avgByModel);
  if (averages.length > 0) {
    console.log("\n=== Average score by model ===");
    for (const [model, scores] of averages) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      console.log(`${model}: ${avg.toFixed(2)}/5 (n=${scores.length})`);
    }
  }
  if (unscored > 0) {
    console.log(
      `\n${unscored} item(s) could not be scored (judge failure or unparseable ` +
        `judge output) and were excluded from the averages. They are logged ` +
        `in Langfuse under the "llm-judge-error" score.`
    );
  }

  // Deterministic scores, when any item declared a schema. Reported separately
  // from the judge average so the two are never averaged together.
  const schemaResults = results.filter((r) => !r.error && r.schemaScore);
  if (schemaResults.length > 0) {
    const byModel = {};
    for (const r of schemaResults) {
      const key = `${r.model} (${r.provider})`;
      byModel[key] ??= [];
      byModel[key].push(r.schemaScore.value);
    }
    console.log("\n=== JSON schema validity (deterministic) ===");
    for (const [model, values] of Object.entries(byModel)) {
      const passed = values.filter((v) => v === 1).length;
      console.log(`${model}: ${passed}/${values.length} responses conform`);
    }
    for (const r of schemaResults.filter((x) => x.schemaScore.value !== 1)) {
      console.log(`  - ${r.itemId}: ${r.schemaScore.comment}`);
    }
  }

  // Flag responses the provider cut short. These usually mean the context window
  // was too small for the requested num_predict, not that the model did badly.
  const cutShort = results.filter((r) => !r.error && r.truncated === true);
  if (cutShort.length > 0) {
    console.log(`\n=== Truncated responses ===`);
    for (const r of cutShort) {
      console.log(`  - ${r.model} (${r.provider}) on "${r.itemId}"`);
    }
    console.log(
      `  The provider stopped generating before the answer was finished. Scores for ` +
        `these items are unreliable: raise the context window (OLLAMA_CONTEXT_LENGTH) ` +
        `or lower num_predict in complex_prompt.md.`
    );
  }
}

// Flush scores and spans in `finally` so a crash part-way through a run still
// ships the traces collected so far instead of dropping them on exit.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await langfuse.flush();
    await langfuseSpanProcessor.forceFlush();
  });
