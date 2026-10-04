import "./helpers/env.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig, projectToEnv, parseProfileArg } from "../src/config.js";

// resolveConfig takes the path as an argument, so each test writes a real
// fixture file and hands it over. The temp dir is created inside the repo
// deliberately: Git Bash's /tmp is not the path Node resolves.
const dir = mkdtempSync(join(tmpdir(), "pme-cfg-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function fixture(yaml) {
  const path = join(dir, `c${counter++}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

/** Writes `yaml`, resolves it with an empty environment, returns the result. */
function load(yaml, { argv = [], env = {} } = {}) {
  return resolveConfig({ path: fixture(yaml), argv, env });
}

// --------------------------------------------------------------- validation
// The point of this module: dotenv ignores a mistyped key, so `max_retrries`
// reads fine and silently changes nothing.

test("rejects a mistyped key, with a suggestion", () => {
  assert.throws(
    () => load("providers:\n  groq:\n    max_retrries: 5\n"),
    /unknown key "max_retrries"\. \(did you mean "max_retries"\?\)/
  );
});

test("rejects a mistyped key nested inside a profile", () => {
  assert.throws(
    () => load("profiles:\n  local:\n    judge:\n      modle: x\n", { argv: ["--profile", "local"] }),
    /unknown key "modle"/
  );
});

test("rejects a mistyped key in a profile that is not active", () => {
  // A profile you do not currently run should still not be able to hide a typo.
  assert.throws(
    () => load("profiles:\n  broken:\n    judge:\n      modle: x\n"),
    /unknown key "modle"/
  );
});

test("rejects an unknown top-level key", () => {
  assert.throws(() => load("jnudge:\n  model: x\n"), /unknown key "jnudge"/);
});

test("rejects an unknown key in a provider block named by a profile", () => {
  // Regression: inside a profile, `providers` is keyed by provider name. Getting
  // this wrong rejects the *provider name* as an unknown key, which made the
  // shipped example file itself fail validation.
  const { config } = load(
    "profiles:\n  local:\n    providers:\n      ollama:\n        base_url: http://x\n",
    { argv: ["--profile", "local"] }
  );
  assert.equal(config.providers.ollama.base_url, "http://x");
});

test("rejects wrong types with a readable message", () => {
  assert.throws(() => load("run:\n  enabled_providers: groq\n"), /expected a list like \[groq, ollama\]/);
  assert.throws(() => load("judge:\n  think: \"false\"\n"), /expected true or false \(unquoted\)/);
  assert.throws(() => load("judge:\n  max_completion_tokens: lots\n"), /expected a number/);
  assert.throws(() => load("langfuse:\n  environment: [a, b]\n"), /expected a string/);
});

test("rejects malformed YAML, quoting the parser's own diagnosis", () => {
  assert.throws(() => load("judge:\n  - this: [is\n"), /Could not parse.*c\d+\.yaml/);
});

test("rejects a list containing non-strings", () => {
  assert.throws(() => load("run:\n  enabled_providers: [groq, 7]\n"), /expected a list of strings/);
});

test("rejects an unknown profile name and lists the real ones", () => {
  assert.throws(
    () =>
      load(
        "profiles:\n  local:\n    run:\n      enabled_providers: [ollama]\n  hosted:\n    run:\n      enabled_providers: [groq]\n",
        { argv: ["--profile", "nope"] }
      ),
    /Unknown profile "nope".*local, hosted/
  );
});

// ------------------------------------------------------------------ defaults

test("falls back to built-in defaults when the file is absent", () => {
  // `env` is passed explicitly because importing this module projects the
  // resolved config into process.env, and those projected values would
  // otherwise be read back as if the user had set them. Harmless for the
  // one-shot CLI (it resolves exactly once), confusing in a test.
  const { config, source } = resolveConfig({ path: join(dir, "does-not-exist.yaml"), env: {} });
  assert.match(source, /built-in defaults/);
  assert.equal(config.judge.max_completion_tokens, 512);
  assert.equal(config.providers.ollama.base_url, "http://localhost:11434");
  assert.deepEqual(config.run.enabled_providers, ["groq", "nvidia", "ollama"]);
});

test("an empty file is valid and changes nothing", () => {
  assert.equal(load("").config.judge.model, "openai/gpt-oss-20b");
});

test("a partial file only overrides what it mentions", () => {
  const { config } = load("judge:\n  model: only-this\n");
  assert.equal(config.judge.model, "only-this");
  assert.equal(config.judge.max_completion_tokens, 512, "sibling keeps its default");
  assert.equal(config.providers.groq.max_retries, 5);
});

// ------------------------------------------------------------------ profiles

test("profiles layer over the base config without erasing it", () => {
  const base = load("run:\n  enabled_providers: [groq, nvidia]\njudge:\n  model: base-model\nproviders:\n  groq:\n    max_retries: 5\n");
  assert.deepEqual(base.config.run.enabled_providers, ["groq", "nvidia"]);
  assert.equal(base.config.judge.model, "base-model");

  const local = load(
    "run:\n  enabled_providers: [groq, nvidia]\njudge:\n  model: base-model\nproviders:\n  groq:\n    max_retries: 5\n" +
      "profiles:\n  local:\n    run:\n      enabled_providers: [ollama]\n    judge:\n      model: qwen3.8:27b\n",
    { argv: ["--profile", "local"] }
  );
  assert.deepEqual(local.config.run.enabled_providers, ["ollama"]);
  assert.equal(local.config.judge.model, "qwen3.8:27b");
  assert.equal(local.config.providers.groq.max_retries, 5, "untouched settings survive");
});

test("the `profile:` key selects the default profile", () => {
  const { profile, config } = load(
    "profile: hosted\nrun:\n  enabled_providers: [groq]\nprofiles:\n  hosted:\n    run:\n      enabled_providers: [nvidia]\n"
  );
  assert.equal(profile, "hosted");
  assert.deepEqual(config.run.enabled_providers, ["nvidia"]);
});

test("a flag beats the `profile:` key", () => {
  const yaml =
    "profile: hosted\nprofiles:\n  hosted:\n    run:\n      enabled_providers: [groq]\n  local:\n    run:\n      enabled_providers: [ollama]\n";
  assert.equal(load(yaml, { argv: ["--profile", "local"] }).profile, "local");
  assert.equal(load(yaml, { argv: ["--profile=local"] }).profile, "local");
});

test("parseProfileArg handles both spellings and ignores other args", () => {
  assert.equal(parseProfileArg(["--profile", "local"]), "local");
  assert.equal(parseProfileArg(["--profile=local"]), "local");
  assert.equal(parseProfileArg(["complex-image", "--profile", "local"]), "local");
  assert.equal(parseProfileArg(["complex-image"]), undefined);
});

// ----------------------------------------------------------------- env layers

test("environment variables override the file", () => {
  const { config } = load("run:\n  enabled_providers: [groq]\njudge:\n  model: from-file\n", {
    env: { ENABLED_PROVIDERS: "groq,nvidia", JUDGE_MODEL: "from-env" },
  });
  assert.deepEqual(config.run.enabled_providers, ["groq", "nvidia"], "comma list becomes an array");
  assert.equal(config.judge.model, "from-env");
});

test("env overrides reach three levels deep without clobbering siblings", () => {
  // Regression: a three-segment path was destructured to two, writing the number
  // over the whole provider object and leaving max_retries undefined.
  const { config } = load("providers:\n  groq:\n    max_retries: 5\n    min_request_interval_ms: 2200\n", {
    env: { GROQ_MAX_RETRIES: "9" },
  });
  assert.equal(config.providers.groq.max_retries, 9);
  assert.equal(config.providers.groq.min_request_interval_ms, 2200, "sibling survives");
});

test("an env override still wins over the active profile", () => {
  const { config } = load("profiles:\n  local:\n    judge:\n      model: profile-model\n", {
    argv: ["--profile", "local"],
    env: { JUDGE_MODEL: "env-model" },
  });
  assert.equal(config.judge.model, "env-model");
});

test("a non-numeric env override is rejected rather than becoming NaN", () => {
  assert.throws(() => load("", { env: { GROQ_MAX_RETRIES: "lots" } }), /GROQ_MAX_RETRIES="lots" is not a number/);
});

test("booleans are coerced properly", () => {
  assert.equal(load("", { env: { JUDGE_THINK: "true" } }).config.judge.think, true);
  assert.equal(load("", { env: { JUDGE_THINK: "false" } }).config.judge.think, false);
});

test("blank entries in an env list are dropped", () => {
  const { config } = load("", { env: { ENABLED_PROVIDERS: " groq , , nvidia " } });
  assert.deepEqual(config.run.enabled_providers, ["groq", "nvidia"]);
});

// ---------------------------------------------------------------- projection

const FULL_CONFIG = {
  run: { enabled_providers: ["ollama"] },
  judge: { provider: "ollama", model: "qwen3.8:27b", max_completion_tokens: 512, think: false },
  providers: {
    groq: { min_request_interval_ms: 2200, max_retries: 5 },
    nvidia: { min_request_interval_ms: 2200, max_retries: 5 },
    ollama: { base_url: "http://localhost:11434", min_request_interval_ms: 0, max_retries: 2 },
  },
  langfuse: { base_url: "https://cloud.langfuse.com", environment: "dev" },
};

test("projection writes values into process.env for the Langfuse SDK to read", () => {
  const env = {};
  projectToEnv(FULL_CONFIG, env);
  assert.equal(env.ENABLED_PROVIDERS, "ollama");
  assert.equal(env.JUDGE_MODEL, "qwen3.8:27b");
  assert.equal(env.JUDGE_THINK, "false");
  assert.equal(env.JUDGE_MAX_COMPLETION_TOKENS, "512");
  assert.equal(env.OLLAMA_BASE_URL, "http://localhost:11434");
  assert.equal(env.GROQ_MAX_RETRIES, "5");
  assert.equal(env.LANGFUSE_TRACING_ENVIRONMENT, "dev");
});

test("projection never clobbers a real environment variable", () => {
  const env = { JUDGE_MODEL: "set-in-the-shell" };
  projectToEnv(FULL_CONFIG, env);
  assert.equal(env.JUDGE_MODEL, "set-in-the-shell");
});

test("projection skips absent optional values instead of writing \"undefined\"", () => {
  const env = {};
  projectToEnv(FULL_CONFIG, env);
  assert.ok(!("LANGFUSE_RELEASE" in env), "an unset release must not become 'undefined'");
  assert.ok(
    !Object.values(env).includes("undefined"),
    "no value may serialize to the string 'undefined'"
  );
});

// -------------------------------------------------- the shipped example file

test("eval.config.example.yaml validates as shipped", () => {
  const { config } = resolveConfig({
    path: join(process.cwd(), "eval.config.example.yaml"),
    env: {},
  });
  assert.ok(config.providers.ollama.base_url.startsWith("http"));
  assert.equal(config.judge.max_completion_tokens, 512);
  assert.equal(config.providers.groq.max_retries, 5);
  assert.equal(config.run.enabled_providers.length, 2);
});