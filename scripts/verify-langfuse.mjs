// Verifies the Langfuse integration without touching a real project or a real
// model provider.
//
// It runs the REAL pipeline (src/runEval.js -> src/instrumentation.js ->
// LangfuseSpanProcessor + LangfuseClient) but:
//   - points LANGFUSE_BASE_URL at a local mock server, so nothing is ingested
//     into your Langfuse project, and
//   - stubs global fetch for the model/judge calls, so no provider is billed.
//
// Then it parses what actually left the process (OTLP/HTTP JSON export plus the
// score-write batch) and asserts what the harness depends on: the ingestion
// paths, attributes propagated to the root AND the child generation, session id
// on the cost-bearing generation, observation-level scores, and media upload in
// place of inline base64.
//
// Usage: yarn verify:langfuse
const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

import { startMockLangfuse } from "./mock-langfuse.mjs";

// Shared with scripts/eval-dry.mjs so both agree on what counts as a request
// worth recording.
const { baseUrl, captured, close: closeMock } = await startMockLangfuse();

// --- env must be set BEFORE any harness module is imported: the provider
// --- clients read their throttle interval at import time, and tracing env must
// --- be in place.
process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-migration-test";
process.env.LANGFUSE_SECRET_KEY = "sk-lf-migration-test";
process.env.LANGFUSE_BASE_URL = baseUrl;
process.env.LANGFUSE_TRACING_ENVIRONMENT = "migration-test";
process.env.ENABLED_PROVIDERS = "groq";
process.env.GROQ_MIN_REQUEST_INTERVAL_MS = "0";
process.env.NVIDIA_MIN_REQUEST_INTERVAL_MS = "0";
process.argv.push("image"); // smallest dataset: 1 groq vision model x 3 items

/** A minimal object satisfying src/datasets/complex_prompt.md's schema. */
const CONFORMANT_TAIJI = {
  summary: "a person standing in a wide stance",
  visible_posture: {
    stance: "wide", weight_distribution: "even", foot_position: "shoulder width",
    leg_position: "bent", torso_alignment: "upright", head_and_gaze: "forward",
    left_arm_and_hand: "raised", right_arm_and_hand: "low", overall_alignment: "stable",
  },
  visible_movement: {
    direction: "left", weight_shift: "to the left leg", stepping_motion: "none visible",
    arm_motion: "extended", hand_motion: "open", torso_motion: "rotating",
    likely_phase: "transition",
  },
  taiji_context: {
    possible_posture_or_transition: "warding", apparent_intent: "balancing",
    technical_points: ["relaxed shoulders"],
  },
  limitations: ["single frame"],
  confidence: 0.7,
};

// ------------------------------------------------- stub the provider (model) calls
const allIds = [];
const modelCalls = [];
// Flipped before the resilience scenario so the judge returns prose instead of
// JSON, exercising the unscored path.
let judgeGarbage = false;
// When true the model under test returns a schema-conformant JSON object
// wrapped in a ```json fence, which is what the complex-image dataset expects.
let modelReturnsSchemaJson = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  // Langfuse's own client uses global fetch -- let that traffic reach the mock.
  if (String(url).startsWith(baseUrl)) return realFetch(url, options);

  if (!options.body) {
    // Model listing: pretend every configured id exists.
    return new Response(JSON.stringify({ data: allIds.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const payload = JSON.parse(options.body);
  const messages = JSON.stringify(payload.messages);
  const isJudge = messages.includes("impartial evaluator");
  // The startup availability check fires a "ping" completion per provider.
  const isProbe = messages.includes('"ping"') && !isJudge;
  modelCalls.push({ model: payload.model, isJudge, isProbe, payload });

  const judgeContent = judgeGarbage
    ? "Sure! I'd say that's a pretty solid answer overall."
    : JSON.stringify({ score: 4, reasoning: "stubbed judge score" });

  const modelContent = modelReturnsSchemaJson
    ? "```json\n" + JSON.stringify(CONFORMANT_TAIJI) + "\n```"
    : "stubbed model output";

  return new Response(
    JSON.stringify({
      choices: [{ message: { content: isJudge ? judgeContent : modelContent } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

// ------------------------------------------------------------ run the real thing
// Import order mirrors runEval.js: instrumentation first (loads .env), then the
// model/judge modules.
await import("../src/instrumentation.js");
const { MODELS_UNDER_TEST, VISION_MODELS } = await import("../src/models.js");
const { JUDGE_MODEL } = await import("../src/judge.js");
allIds.push(
  ...[...MODELS_UNDER_TEST, ...VISION_MODELS].map((m) => (typeof m === "string" ? m : m.id)),
  JUDGE_MODEL
);

// Run-completion detection. Keying only off the "=== Average score by model ===
// header is brittle: that header is now suppressed when nothing scored, so a
// fully-unscored run would never be seen as finished. Detect the end of the
// summary if it printed, and otherwise fall back to the HTTP stream going quiet.
function watchForCompletion(state) {
  const realLog = console.log;
  console.log = (...args) => {
    const line = args.join(" ");
    if (line.startsWith("Langfuse session: ")) state.sessionId = line.slice("Langfuse session: ".length);
    if (line.startsWith("Running ")) state.started = true;
    if (line.includes("=== Average score by model ===") || line.includes("could not be scored")) {
      state.finished = true;
    }
    realLog(...args);
  };
  return () => {
    console.log = realLog;
  };
}

const realLog = console.log;

/**
 * Runs the harness end to end and returns only the HTTP traffic it produced.
 *
 * `?scenario=N` makes each import a distinct module record, so runEval.js's
 * self-executing main() runs again for the resilience scenario below.
 */
async function runScenario({ dataset = "image", schemaJson = false } = {}) {
  const from = captured.length;
  modelCalls.length = 0;
  const state = { sessionId: null, started: false, finished: false };
  const restoreLog = watchForCompletion(state);

  // runEval resolves its dataset from argv at call time; rewrite it so each
  // scenario can target a different one.
  process.argv = [process.argv[0], process.argv[1], dataset];
  modelReturnsSchemaJson = schemaJson;

  await import(`../src/runEval.js?scenario=${dataset}-${judgeGarbage ? "judge-garbage" : "happy"}`);

  const deadline = Date.now() + 90_000;
  let quietTicks = 0;
  let seen = captured.length;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (state.finished) break;
    if (captured.length === seen) {
      if (state.started && ++quietTicks >= 12) break; // 3s of silence after work began
    } else {
      quietTicks = 0;
      seen = captured.length;
    }
  }
  await new Promise((r) => setTimeout(r, 3000)); // let flush() + forceFlush() land
  restoreLog();

  return {
    traffic: captured.slice(from),
    sessionId: state.sessionId,
    finished: state.finished || state.started,
    modelCalls: [...modelCalls],
  };
}

const happy = await runScenario();

// ------------------------------------------------------------------- assertions
const otel = happy.traffic.filter((r) => r.path.includes("/otel/"));
const ingestion = happy.traffic.filter((r) => r.path.includes("/ingestion"));
const media = happy.traffic.filter((r) => r.path.includes("/media"));
const byPath = (list) => list.map((r) => `${r.path}(${r.body.length}b)`).join(", ");
const attr = (span, key) => {
  const raw = span.attributes?.find((a) => a.key === key)?.value;
  if (!raw) return undefined;
  if (raw.stringValue !== undefined) return raw.stringValue;
  if (raw.boolValue !== undefined) return raw.boolValue;
  if (raw.arrayValue !== undefined) return raw.arrayValue.values.map((v) => v.stringValue ?? v);
  return JSON.stringify(raw);
};

check(happy.finished, "eval run completed", byPath(happy.traffic));
check(otel.length > 0, "spans exported over OTLP to /otel/v1/traces", byPath(otel));
check(
  otel.every((r) => (r.headers.authorization || "").startsWith("Basic ")),
  "OTLP export sends Basic auth"
);

const spans = otel.flatMap((r) =>
  JSON.parse(r.body.toString("utf8")).resourceSpans.flatMap((rs) =>
    rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => ({ ...s, scope: ss.scope?.name })))
  )
);
const roots = spans.filter((s) => attr(s, "langfuse.internal.is_app_root") === true);
const gens = spans.filter((s) => attr(s, "langfuse.observation.type") === "generation");

check(spans.length === 6, "3 traces x 2 observations exported (default span filter kept them)", `spans=${spans.length}`);
check(roots.length === 3 && gens.length === 3, "exactly 3 root spans + 3 generations", `roots=${roots.length}, gens=${gens.length}`);
check(spans.every((s) => s.scope === "langfuse-sdk"), "all spans from the langfuse-sdk scope");

// Correlating attributes must be on the root AND every child observation.
check(
  spans.every((s) => attr(s, "session.id") === happy.sessionId),
  "session id propagated to root and child observations",
  happy.sessionId ?? "none"
);
check(
  spans.every((s) => String(attr(s, "langfuse.trace.name") || "").startsWith("eval:qwen/")),
  "trace name propagated to root and child observations"
);
check(
  spans.every((s) => (attr(s, "langfuse.trace.tags") || []).includes("dataset:image")),
  "tags propagated (dataset:image)"
);
check(
  spans.every((s) => (attr(s, "langfuse.trace.tags") || []).includes("provider:groq")),
  "tags propagated (provider:groq)"
);
check(spans.every((s) => attr(s, "langfuse.environment") === "migration-test"), "environment propagated");
check(
  spans.every((s) => ["geom-aspect-ratio", "geom-spatial-1", "colors-objects-1"].includes(attr(s, "langfuse.trace.metadata.datasetId"))),
  "datasetId metadata propagated"
);
check(spans.every((s) => attr(s, "langfuse.trace.metadata.hasImage") === "true"), "hasImage metadata propagated");

// Metadata constraint: string values, <= 200 chars. The long judging
// criteria must therefore live on the root observation input, not metadata.
const mdKeys = [...new Set(spans.flatMap((s) => (s.attributes ?? []).map((a) => a.key)))].filter((k) =>
  k.startsWith("langfuse.trace.metadata.")
);
const mdValues = spans.flatMap((s) => mdKeys.map((k) => attr(s, k)));
check(mdKeys.every((k) => k !== "langfuse.trace.metadata.criteria"), "criteria not placed in propagated metadata", mdKeys.join(","));
check(mdValues.every((v) => typeof v === "string" && v.length <= 200), "all propagated metadata values are short strings");

// Root observation carries overall input/output.
const rootInput = roots.map((s) => attr(s, "langfuse.observation.input")).join(" ");
check(rootInput.includes("What is the") && rootInput.includes("criteria"), "root observation holds the overall input (prompt + criteria)");
check(
  roots.every((s) => String(attr(s, "langfuse.observation.output") || "").includes("stubbed model output")),
  "root observation holds the overall output"
);

// Cost-bearing generation must carry model + usage + session for session cost.
check(gens.every((s) => attr(s, "langfuse.observation.model.name") === "qwen/qwen3.8-27b"), "generation carries model name");
check(gens.every((s) => Boolean(attr(s, "langfuse.observation.usage_details"))), "generation carries usage details");

check(media.length > 0, "base64 image uploaded as Langfuse media", byPath(media));
check(
  !otel.some((r) => r.body.toString("utf8").includes("data:image/png;base64")),
  "inline base64 stripped from span payloads (media reference used instead)"
);

check(ingestion.length > 0, "score writes reach /ingestion", byPath(ingestion));
const scoreEvents = [];
for (const r of ingestion) {
  try {
    const parsed = JSON.parse(r.body.toString("utf8"));
    for (const batch of parsed.batch ?? []) if (batch.type === "score-create") scoreEvents.push(batch.body);
  } catch {
    /* not JSON */
  }
}
check(scoreEvents.length === 3, "one score per trace", `scores=${scoreEvents.length}`);
check(
  scoreEvents.every((s) => s.name === "llm-judge-score" && s.dataType === "NUMERIC" && s.value === 4),
  "score name/value/dataType are correct"
);
check(
  scoreEvents.every((s) => gens.some((g) => g.spanId === s.observationId)),
  "score attached to the generation observation (observationId matches a generation spanId)"
);
check(
  scoreEvents.every((s) => roots.some((r) => r.traceId === s.traceId)),
  "score traceId matches an exported trace"
);
check(new Set(scoreEvents.map((s) => s.observationId)).size === 3, "scores attached to distinct observations");

const underTest = happy.modelCalls.filter((c) => !c.isJudge && !c.isProbe);
check(underTest.length === 3, "model called once per item", `calls=${underTest.length}`);
check(happy.modelCalls.filter((c) => c.isJudge).length === 3, "judge called once per item");

// ------------------------------------------------- resilience: judge returns junk
// Regression guard. Previously a judge that could not produce a score escaped
// runOne, aborted main() and skipped flush() -- so one bad judge response threw
// away every trace in the run. The harness must finish, still export all three
// traces, and record the failures as "llm-judge-error" rather than a numeric 0
// that would be indistinguishable from a bad model answer.
realLog("\n--- resilience scenario: judge returns unparseable output ---");
judgeGarbage = true;
const degraded = await runScenario({ judgeGarbage: true });

const degradedSpans = degraded.traffic
  .filter((r) => r.path.includes("/otel/"))
  .flatMap((r) => JSON.parse(r.body.toString("utf8")).resourceSpans.flatMap((rs) =>
    rs.scopeSpans.flatMap((ss) => ss.spans)));
const degradedScores = [];
for (const r of degraded.traffic.filter((x) => x.path.includes("/ingestion"))) {
  try {
    const parsed = JSON.parse(r.body.toString("utf8"));
    for (const batch of parsed.batch ?? []) if (batch.type === "score-create") degradedScores.push(batch.body);
  } catch {
    /* not JSON */
  }
}

check(degraded.finished, "run completes even when every judge response is unparseable");
check(degradedSpans.length === 6, "all 3 traces still exported after judge failure", `spans=${degradedSpans.length}`);
check(degraded.modelCalls.filter((c) => c.isJudge).length === 3, "judge still attempted once per item");
check(
  degradedScores.length === 3 && degradedScores.every((s) => s.name === "llm-judge-error"),
  "judge failures logged as llm-judge-error",
  `names=${[...new Set(degradedScores.map((s) => s.name))].join(",")}`
);
check(
  degradedScores.every((s) => typeof s.value === "string" && !/^\d+$/.test(String(s.value))),
  "no numeric 0 written for an unscored item",
  `values=${degradedScores.map((s) => s.value).join(",")}`
);
check(
  degradedScores.every((s) => /Failed to parse judge output/.test(String(s.comment))),
  "score comment carries the parse failure reason"
);
check(
  degradedScores.every((s) => degradedSpans.some((sp) => sp.spanId === s.observationId)),
  "error score still attached to its generation observation"
);

// -------------------------------------------- complex-image dataset (from disk)
// The structured-output path: a real binary JPEG read from src/assets/images/,
// base64-encoded at load time, sent as an OpenAI content part, with the
// captured prompt's JSON schema mapped onto `response_format` and scored
// deterministically as well as by the judge.
realLog("\n--- complex-image dataset: binary image + structured output ---");
judgeGarbage = false;
const complex = await runScenario({ dataset: "complex-image", schemaJson: true });

const complexChat = complex.modelCalls.find((c) => !c.isJudge && !c.isProbe)?.payload;
const content = complexChat?.messages?.[0]?.content;
const imagePart = Array.isArray(content) ? content.find((p) => p.type === "image_url") : null;
const imageUrl = imagePart?.image_url?.url ?? "";

check(complex.finished, "complex-image run completes");
check(Array.isArray(content) && content.length === 2, "prompt sent as text + image parts");
check(
  imageUrl.startsWith("data:image/jpeg;base64,"),
  "binary JPEG read from disk and sent as a base64 data URL",
  imageUrl.slice(0, 32)
);
check(imageUrl.length > 700_000, "full-resolution image attached, not downscaled", `${imageUrl.length} chars`);
check(!imageUrl.includes("video-to-practice"), "stale external path from the captured request ignored");
check(complexChat?.response_format?.type === "json_schema", "prompt's JSON schema mapped to response_format");
check(
  complexChat?.response_format?.json_schema?.schema?.properties?.visible_posture?.type === "object",
  "schema body forwarded verbatim"
);
check(complexChat?.temperature === 0.8, "per-item temperature applied", String(complexChat?.temperature));
check(
  complexChat?.max_completion_tokens === 8192,
  "Ollama num_predict mapped to max_completion_tokens",
  String(complexChat?.max_completion_tokens)
);
check(
  complexChat?.response_format == null || complexChat?.repeat_penalty === undefined,
  "unmappable repeat_penalty not sent to the provider"
);

const complexScores = complex.traffic
  .filter((r) => r.path.includes("/ingestion"))
  .flatMap((r) => {
    try {
      return (JSON.parse(r.body).batch ?? []).filter((b) => b.type === "score-create").map((b) => b.body);
    } catch {
      return [];
    }
  });
const schemaScores = complexScores.filter((s) => s.name === "json-schema-valid");
check(schemaScores.length === 1, "deterministic json-schema-valid score written", `n=${schemaScores.length}`);
check(
  schemaScores.every((s) => s.value === 1),
  "fenced-but-schema-conformant output scores 1",
  JSON.stringify(schemaScores.map((s) => s.value))
);
check(
  complexScores.some((s) => s.name === "llm-judge-score"),
  "LLM judge score still written alongside the deterministic one"
);
const complexOtel = complex.traffic.filter((r) => r.path.includes("/otel/"));
check(
  complexOtel.every((r) => !r.body.toString("utf8").includes("data:image/jpeg;base64,")),
  "inline base64 stripped from complex-image span payloads"
);

await closeMock();
realLog("\n" + (failures.length === 0 ? "ALL CHECKS PASSED" : `FAILED (${failures.length}): ${failures.join("; ")}`));
process.exit(failures.length === 0 ? 0 : 1);
