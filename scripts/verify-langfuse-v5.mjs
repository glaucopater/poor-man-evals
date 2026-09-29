// Verifies the Langfuse v4/v5 migration without touching a real project or a
// real model provider.
//
// It runs the REAL pipeline (src/runEval.js -> src/instrumentation.js ->
// LangfuseSpanProcessor + LangfuseClient) but:
//   - points LANGFUSE_BASE_URL at a local mock server, so nothing is ingested
//     into your Langfuse project, and
//   - stubs global fetch for the model/judge calls, so no provider is billed.
//
// Then it parses what actually left the process (OTLP/HTTP JSON export plus the
// score-write batch) and asserts the v5 requirements: v4 ingestion path,
// attributes propagated to the root AND the child generation, session id on the
// cost-bearing generation, and observation-level scores.
//
// Usage: yarn verify:langfuse
import { createServer } from "node:http";

const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

// ---------------------------------------------------------------- mock Langfuse
const captured = [];
const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured.push({ path: req.url.split("?")[0], headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url.includes("/otel/")) {
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end(Buffer.alloc(0));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ successes: [], errors: [] }));
    }
  });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${mock.address().port}`;

// --- env must be set BEFORE any harness module is imported: groqClient.js reads
// --- its throttle interval at import time, and tracing env must be in place.
process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-migration-test";
process.env.LANGFUSE_SECRET_KEY = "sk-lf-migration-test";
process.env.LANGFUSE_BASE_URL = baseUrl;
process.env.LANGFUSE_TRACING_ENVIRONMENT = "migration-test";
process.env.ENABLED_PROVIDERS = "groq";
process.env.GROQ_MIN_REQUEST_INTERVAL_MS = "0";
process.env.NVIDIA_MIN_REQUEST_INTERVAL_MS = "0";
process.argv.push("image"); // smallest dataset: 1 groq vision model x 3 items

// ------------------------------------------------- stub the provider (model) calls
const allIds = [];
const modelCalls = [];
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
  modelCalls.push({ model: payload.model, isJudge, isProbe });

  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: isJudge
              ? JSON.stringify({ score: 4, reasoning: "stubbed judge score" })
              : "stubbed model output",
          },
        },
      ],
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

let sessionId = null;
let finished = false;
const realLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  if (line.startsWith("Langfuse session: ")) sessionId = line.slice("Langfuse session: ".length);
  if (line.includes("=== Average score by model ===")) finished = true;
  realLog(...args);
};

await import("../src/runEval.js");

const deadline = Date.now() + 90_000;
while (!finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 3000)); // let flush() + forceFlush() land
console.log = realLog;

// ------------------------------------------------------------------- assertions
const otel = captured.filter((r) => r.path.includes("/otel/"));
const ingestion = captured.filter((r) => r.path.includes("/ingestion"));
const media = captured.filter((r) => r.path.includes("/media"));
const byPath = (list) => list.map((r) => `${r.path}(${r.body.length}b)`).join(", ");
const attr = (span, key) => {
  const raw = span.attributes?.find((a) => a.key === key)?.value;
  if (!raw) return undefined;
  if (raw.stringValue !== undefined) return raw.stringValue;
  if (raw.boolValue !== undefined) return raw.boolValue;
  if (raw.arrayValue !== undefined) return raw.arrayValue.values.map((v) => v.stringValue ?? v);
  return JSON.stringify(raw);
};

check(finished, "eval run completed", byPath(captured));
check(otel.length > 0, "spans exported to the v4 OTLP path /otel/v1/traces", byPath(otel));
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

check(spans.length === 6, "3 traces x 2 observations exported (v5 span filter kept them)", `spans=${spans.length}`);
check(roots.length === 3 && gens.length === 3, "exactly 3 root spans + 3 generations", `roots=${roots.length}, gens=${gens.length}`);
check(spans.every((s) => s.scope === "langfuse-sdk"), "all spans from the langfuse-sdk scope");

// v5: correlating attributes must be on the root AND every child observation.
check(
  spans.every((s) => attr(s, "session.id") === sessionId),
  "session id propagated to root and child observations",
  sessionId ?? "none"
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

// v5 metadata constraint: string values, <= 200 chars. The long judging
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

const underTest = modelCalls.filter((c) => !c.isJudge && !c.isProbe);
check(underTest.length === 3, "model called once per item", `calls=${underTest.length}`);
check(modelCalls.filter((c) => c.isJudge).length === 3, "judge called once per item");

mock.close();
realLog("\n" + (failures.length === 0 ? "ALL CHECKS PASSED" : `FAILED (${failures.length}): ${failures.join("; ")}`));
process.exit(failures.length === 0 ? 0 : 1);
