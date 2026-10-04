/**
 * Runs a real eval with Langfuse replaced by a local mock.
 *
 * Usage:
 *   yarn eval:dry                 # text dataset, same config as a real run
 *   yarn eval:dry image
 *   yarn eval:dry complex-image
 *   yarn eval:dry complex-image --profile local
 *
 * Every model call is real -- same providers, same judge, same tokens -- so this
 * exercises the actual pipeline and tells you what a run would cost and how long
 * it would take. Only the observability endpoint is swapped, so nothing is
 * ingested into a real Langfuse project and no trace or score is created.
 *
 * That last part is the point. A "just checking it works" run against the real
 * project leaves behind a session full of test traces, which is
 * indistinguishable from real results later and quietly pollutes every dashboard
 * and comparison built on the project.
 *
 * The eval runs as a child process rather than an import, for two reasons: the
 * entry point fires `main()` without awaiting it, so importing it would return
 * before the run finished; and a child is the only way to observe the real exit
 * code. The child inherits NODE_OPTIONS, so Yarn PnP still resolves packages.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { startMockLangfuse, summarizeTraffic } from "./mock-langfuse.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { baseUrl, captured, close } = await startMockLangfuse();

const child = spawn(process.execPath, ["src/runEval.js", ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    // The one thing that changes: where telemetry goes.
    LANGFUSE_BASE_URL: baseUrl,
    // Placeholder credentials, so a dry run needs no real project to exist. The
    // mock ignores them and they never leave the machine.
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY || "pk-dry-run-not-a-real-key",
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY || "sk-dry-run-not-a-real-key",
    // An obvious environment name, so if anything ever did leak it would be
    // identifiable in the UI rather than blending into real runs.
    LANGFUSE_TRACING_ENVIRONMENT: "dry-run",
  },
});

const banner = "=".repeat(72);
console.log(`\n${banner}`);
console.log("  DRY RUN - Langfuse is mocked; nothing will be ingested.");
console.log("  Model and judge calls are REAL and will use their quota.");
console.log(banner);

const exitCode = await new Promise((resolveExit) => {
  child.on("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  child.on("error", (err) => {
    console.error(`Failed to start the eval: ${err.message}`);
    resolveExit(1);
  });
});

// runEval flushes after main() settles, so allow the exporter's final batch to
// land before reporting what it sent.
await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
await close();

const traffic = summarizeTraffic(captured);
console.log(`\n${banner}`);
console.log("  DRY RUN COMPLETE - nothing was sent to a real Langfuse project.");
if (traffic.length === 0) {
  console.log("  No telemetry was produced at all - was the run a no-op?");
} else {
  console.log("  Telemetry that WOULD have been ingested:");
  for (const t of traffic) {
    console.log(`    ${t.kind.padEnd(16)} ${String(t.requests).padStart(4)} request(s), ${t.bytes} bytes`);
  }
}
console.log(banner);

process.exit(exitCode);