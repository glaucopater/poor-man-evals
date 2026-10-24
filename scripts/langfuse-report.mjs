// Per-model metrics pulled from Langfuse, for the runs this harness produced.
//
// Why this exists: the numbers that answer "which model is best / fastest" are
// NOT on the trace root span. They live on the child *generation* observation
// (model name, usage, latency) and on the observation-level *scores*
// (`llm-judge-score`, `json-schema-valid`, `response-truncated`). A UI export of
// root spans therefore shows `llm-judge-score: null` and empty `usageDetails`
// for every row. This script joins generation observations with their scores so
// a single command gives the per-model table.
//
// Usage:
//   yarn langfuse:report                     # last 5 eval sessions
//   yarn langfuse:report --last 10
//   yarn langfuse:report --all
//   yarn langfuse:report --session eval-2026-10-18T18-29-11-926Z-9218e2d4
//   yarn langfuse:report --dataset image     # only dataset:image tags
//   yarn langfuse:report --json              # machine-readable aggregate
//
// Reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL from .env
// (same as the harness). Read-only: it never writes traces or scores.

import "dotenv/config";

import { LangfuseClient } from "@langfuse/client";

const HELP = `Usage: yarn langfuse:report [options]

  --session <id>     report one session (repeatable). Skips session discovery.
  --last <n>         how many recent eval sessions to include (default 5)
  --all              include every eval session in the window
  --since <days>     how far back to look for sessions (default 30)
  --dataset <id>     only keep generations tagged dataset:<id> (text|image|complex-image)
  --environment <e>  only sessions from this tracing environment
  --json             print the aggregate as JSON instead of a table
  -h, --help         show this message

"Fastest" here means generation latency (model call only -- the judge is a
separate observation and is excluded). It still includes the client's own
min-request-interval wait, so it is only a fair speed comparison when
NVIDIA_MIN_REQUEST_INTERVAL_MS / GROQ_MIN_REQUEST_INTERVAL_MS are 0.
`;

/** Parses the flag set above. Deliberately tiny -- no dependency, no surprises. */
function parseArgs(argv) {
  const opts = { sessions: [], last: 5, all: false, since: 30, dataset: null, environment: null, project: "default", json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error(`${arg} requires a value.`);
        process.exit(1);
      }
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "--session") opts.sessions.push(next()), i++;
    else if (arg === "--last") opts.last = Number(next()), i++;
    else if (arg === "--all") opts.all = true;
    else if (arg === "--since") opts.since = Number(next()), i++;
    else if (arg === "--dataset") opts.dataset = next(), i++;
    else if (arg === "--environment") opts.environment = next(), i++;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--project") opts.project = next(), i++;
    else {
      console.error(`Unknown option "${arg}".\n\n${HELP}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(opts.last) || opts.last <= 0) opts.last = 5;
  if (!Number.isFinite(opts.since) || opts.since < 0) opts.since = 30;
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const __project = opts.project || "default";
const __upper = __project.toLowerCase() === "default" ? "" : __project.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_";
const __publicKeyEnv = __project.toLowerCase() === "default" ? "LANGFUSE_PUBLIC_KEY" : "LANGFUSE_" + __upper + "PUBLIC_KEY";
const __secretKeyEnv = __project.toLowerCase() === "default" ? "LANGFUSE_SECRET_KEY" : "LANGFUSE_" + __upper + "SECRET_KEY";
const __baseUrlEnv = __project.toLowerCase() === "default" ? "LANGFUSE_BASE_URL" : "LANGFUSE_" + __upper + "BASE_URL";

if (!process.env[__publicKeyEnv] || !process.env[__secretKeyEnv]) {
  console.error(__publicKeyEnv + " / " + __secretKeyEnv + " are not set. Add them to .env.");
  process.exit(1);
}

const client = new LangfuseClient({
  publicKey: process.env[__publicKeyEnv],
  secretKey: process.env[__secretKeyEnv],
  baseUrl: process.env[__baseUrlEnv] || process.env.LANGFUSE_BASE_URL,
});

/** Every observation run through this harness is named `eval:<model>:<item>`. */
const TRACE_PREFIX = "eval:";

/**
 * Splits `eval:<model>:<item>` into its parts.
 *
 * Split from the right: model ids may themselves contain a colon
 * (`nvidia/nemotron-3.5-lightning:free`) while item ids never do, so the last
 * colon is always the model/item boundary.
 */
function parseTraceName(traceName) {
  if (typeof traceName !== "string" || !traceName.startsWith(TRACE_PREFIX)) return null;
  const rest = traceName.slice(TRACE_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut === -1) return null;
  return { model: rest.slice(0, cut), itemId: rest.slice(cut + 1) };
}

/** Pages through `sessions.list` (page/limit based) into one flat array. */
async function listSessions({ sinceDays, environment }) {
  const fromTimestamp = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const all = [];
  for (let page = 1; ; page++) {
    const res = await client.api.sessions.list({ page, limit: 100, fromTimestamp, environment });
    all.push(...(res.data ?? []));
    if (!res.meta || page >= res.meta.totalPages) break;
  }
  return all;
}

/** Pages through observations by cursor until exhausted. */
async function listGenerations(sessionId) {
  const out = [];
  let cursor;
  do {
    const res = await client.api.observations.getMany({
      sessionId,
      type: "GENERATION",
      limit: 1000,
      cursor,
      // Wrong field groups are a 400, so only ask for groups that exist.
      // time -> start/end, model -> model name, usage -> tokens/cost,
      // metrics -> latency, trace_context -> traceName/tags.
      fields: "core,basic,time,model,usage,metrics,metadata,trace_context",
    });
    out.push(...(res.data ?? []));
    cursor = res.meta?.cursor;
  } while (cursor);
  return out;
}

/**
 * Fetches scores for a set of observation ids, chunked into comma-separated
 * `observationId` filters.
 *
 * Not filtered by `sessionId`: scores written at the observation level come back
 * with `sessionId: null`, so the session filter silently matches nothing and
 * every judge score would read as missing. The observation id is the one link
 * that is always populated.
 */
async function listScoresForObservations(ids, chunkSize = 50) {
  const out = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    for (let page = 1; ; page++) {
      const res = await client.api.scores.getMany({
        observationId: chunk.join(","),
        page,
        limit: 100,
        fields: "score,trace",
      });
      out.push(...(res.data ?? []));
      if (!res.meta || page >= res.meta.totalPages) break;
    }
  }
  return out;
}

/** Linear-interpolated quantile; n=1 returns that value. */
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Aggregates generation observations + their scores into one row per model.
 *
 * Generation `latency` is in seconds; everything here is reported in ms so it
 * lines up with the run summary the harness prints.
 */
function aggregate(generations, byObservation) {
  const models = new Map();

  for (const obs of generations) {
    const parsed = parseTraceName(obs.traceName);
    const model = obs.model || parsed?.model || "(unknown)";
    const itemId = parsed?.itemId ?? "(unknown)";

    if (!models.has(model)) {
      models.set(model, {
        model,
        provider: null,
        n: 0,
        judge: [],
        unscored: 0,
        schemaPass: 0,
        schemaTotal: 0,
        truncated: 0,
        latencies: [],
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        items: [],
      });
    }
    const row = models.get(model);
    row.n++;

    const providerTag = (obs.tags ?? []).find((t) => t.startsWith("provider:"));
    if (providerTag) row.provider ??= providerTag.slice("provider:".length);

    for (const score of byObservation.get(obs.id) ?? []) {
      if (score.name === "llm-judge-score" && typeof score.value === "number") {
        row.judge.push(score.value);
      } else if (score.name === "llm-judge-error") {
        row.unscored++;
      } else if (score.name === "json-schema-valid") {
        row.schemaTotal++;
        if (score.value === 1) row.schemaPass++;
      } else if (score.name === "response-truncated") {
        if (score.value === 1) row.truncated++;
      }
    }

    if (typeof obs.latency === "number") row.latencies.push(obs.latency * 1000);
    row.tokensIn += obs.usageDetails?.input ?? 0;
    row.tokensOut += obs.usageDetails?.output ?? 0;
    row.cost += obs.totalCost ?? 0;

    row.items.push({ itemId, latencyMs: obs.latency != null ? obs.latency * 1000 : null });
  }

  return [...models.values()].map((row) => {
    const sorted = [...row.latencies].sort((a, b) => a - b);
    return {
      ...row,
      judgeAvg: mean(row.judge),
      judgeMin: row.judge.length ? Math.min(...row.judge) : null,
      judgeMax: row.judge.length ? Math.max(...row.judge) : null,
      latencyMeanMs: mean(row.latencies),
      latencyP50Ms: quantile(sorted, 0.5),
      latencyP95Ms: quantile(sorted, 0.95),
    };
  });
}

// ------------------------------------------------------------------- collect

let sessionIds;
if (opts.sessions.length > 0) {
  sessionIds = opts.sessions;
} else {
  const sessions = await listSessions({ sinceDays: opts.since, environment: opts.environment });
  const evalSessions = sessions
    .filter((s) => String(s.id).startsWith("eval-"))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  sessionIds = (opts.all ? evalSessions : evalSessions.slice(0, opts.last)).map((s) => s.id);
}

if (sessionIds.length === 0) {
  console.log(`No eval sessions found in the last ${opts.since} day(s). Nothing to report.`);
  process.exit(0);
}

const generations = [];
for (const sessionId of sessionIds) {
  const gens = await listGenerations(sessionId);
  for (const g of gens) generations.push(g);
}

// Scores are joined by observation id, in one pass over every generation we
// pulled -- see listScoresForObservations for why session filtering is unusable.
const scoreData = await listScoresForObservations(generations.map((g) => g.id));

const byObservation = new Map();
for (const score of scoreData) {
  if (!score.observationId) continue;
  if (!byObservation.has(score.observationId)) byObservation.set(score.observationId, []);
  byObservation.get(score.observationId).push(score);
}

const filtered =
  opts.dataset === null
    ? generations
    : generations.filter((g) => (g.tags ?? []).includes(`dataset:${opts.dataset}`));

const rows = aggregate(filtered, byObservation)
  .sort((a, b) => (b.judgeAvg ?? -1) - (a.judgeAvg ?? -1) || b.n - a.n);

// -------------------------------------------------------------------- report

if (opts.json) {
  console.log(JSON.stringify({ sessions: sessionIds, models: rows }, null, 2));
  process.exit(0);
}

const secs = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
const num = (x, d = 2) => (x == null ? "—" : x.toFixed(d));

console.log(`\nLangfuse report — ${sessionIds.length} session(s)`);
for (const id of sessionIds) console.log(`  ${id}`);
if (opts.dataset) console.log(`  filtered to dataset:${opts.dataset}`);
console.log(`  ${filtered.length} generation observation(s)\n`);

const header = [
  "model (provider)".padEnd(46),
  "n".padStart(3),
  "judge".padStart(6),
  "min-max".padStart(9),
  "schema".padStart(6),
  "trunc".padStart(5),
  "p50".padStart(7),
  "p95".padStart(7),
  "in tok".padStart(9),
  "out tok".padStart(9),
  "cost".padStart(9),
].join(" ");
console.log(header);
console.log("-".repeat(header.length));

for (const r of rows) {
  const label = `${r.model} (${r.provider ?? "?"})`;
  const schema = r.schemaTotal ? `${r.schemaPass}/${r.schemaTotal}` : "—";
  const minmax = r.judgeMin == null ? "—" : `${r.judgeMin}–${r.judgeMax}`;
  console.log(
    [
      label.padEnd(46),
      String(r.n).padStart(3),
      num(r.judgeAvg, 1).padStart(6),
      minmax.padStart(9),
      schema.padStart(6),
      String(r.truncated).padStart(5),
      secs(r.latencyP50Ms).padStart(7),
      secs(r.latencyP95Ms).padStart(7),
      String(Math.round(r.tokensIn)).padStart(9),
      String(Math.round(r.tokensOut)).padStart(9),
      `$${r.cost.toFixed(4)}`.padStart(9),
    ].join(" ")
  );
}

const withScore = rows.filter((r) => r.judgeAvg != null);
const withLatency = rows.filter((r) => r.latencyP50Ms != null);
if (withScore.length > 0) {
  const bestVal = Math.max(...withScore.map((r) => r.judgeAvg));
  const tied = withScore.filter((r) => Math.abs(r.judgeAvg - bestVal) < 0.005);
  const names = tied.map((r) => `${r.model} (n=${r.judge.length})`).join(", ");
  console.log(`\nbest score:   ${num(bestVal, 2)}/5 — ${names}${tied.length > 1 ? " [tie]" : ""}`);
}
if (withLatency.length > 0) {
  const fastest = withLatency.reduce((a, b) => (b.latencyP50Ms < a.latencyP50Ms ? b : a));
  console.log(`fastest p50:  ${fastest.model} (${secs(fastest.latencyP50Ms)})`);
  console.log(
    `\nNote: latency includes the client's min-request-interval wait, so it only ` +
      `reflects model speed when GROQ_/NVIDIA_MIN_REQUEST_INTERVAL_MS=0.`
  );
}
const unscoredTotal = rows.reduce((sum, r) => sum + r.unscored, 0);
if (unscoredTotal > 0) {
  console.log(`${unscoredTotal} generation(s) were unscorable (llm-judge-error) and are excluded from the judge average.`);
}
