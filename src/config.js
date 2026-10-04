/**
 * Structured configuration.
 *
 * Why this exists alongside .env rather than replacing it:
 *
 *   1. `new LangfuseClient()` in runEval.js is constructed with no arguments,
 *      and the Langfuse SDK reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY /
 *      LANGFUSE_BASE_URL / LANGFUSE_TRACING_ENVIRONMENT straight out of
 *      process.env. So process.env has to be populated no matter what.
 *   2. One-off overrides are genuinely useful: `ENABLED_PROVIDERS=ollama yarn
 *      eval:complex` should beat the file, because that is the whole point of
 *      an escape hatch.
 *
 * So this module is a *front end*: it resolves a structured YAML file into
 * concrete values and projects them into process.env, which every existing
 * `process.env.X` read then picks up unchanged.
 *
 * The payoff over plain dotenv is not the nesting -- it is the validation.
 * dotenv silently ignores a key you mistyped, so `GROQ_MAX_RETRES=5` does
 * nothing at all and looks like it worked. Here an unknown key is a hard error
 * naming the offending path.
 *
 * Precedence, lowest to highest:
 *   built-in defaults  <  eval.config.yaml  <  selected profile  <  process.env
 *
 * Secrets are NOT read from here: they stay in .env, which gitignores. That
 * keeps this file committable and shareable, and keeps .env down to bare keys.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import "dotenv/config"; // secrets only; must load before we read process.env

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, "eval.config.yaml");

// ---------------------------------------------------------------------------
// Schema. Every legal key is listed here. Anything else is an error, which is
// the entire point: a silently-ignored typo is a silent misconfiguration.

const PROVIDER_SCHEMA = {
  base_url: "string",
  min_request_interval_ms: "number",
  max_retries: "number",
};

const RUN_SCHEMA = { enabled_providers: "list" };

const JUDGE_SCHEMA = {
  provider: "string",
  model: "string",
  max_completion_tokens: "number",
  think: "boolean",
};

const LANGFUSE_SCHEMA = {
  base_url: "string",
  environment: "string",
  release: "string",
};

/**
 * A profile can override any of the top-level sections. Inside one, `providers`
 * is keyed by provider name -- hence `each` -- while at the top level the
 * schema already names each provider explicitly.
 */
const PROFILE_SCHEMA = {
  run: RUN_SCHEMA,
  judge: JUDGE_SCHEMA,
  providers: { each: PROVIDER_SCHEMA },
  langfuse: LANGFUSE_SCHEMA,
};

const SCHEMA = {
  profile: "string",
  profiles: { type: "object", each: PROFILE_SCHEMA },
  run: RUN_SCHEMA,
  judge: JUDGE_SCHEMA,
  providers: { type: "object", each: PROVIDER_SCHEMA },
  langfuse: LANGFUSE_SCHEMA,
};

/**
 * Built-in defaults, used when eval.config.yaml is absent so the harness still
 * runs with nothing but .env (the pre-YAML behaviour).
 */
const DEFAULTS = {
  profile: "default",
  run: { enabled_providers: ["groq", "nvidia", "ollama"] },
  judge: {
    provider: "groq",
    model: "openai/gpt-oss-20b",
    max_completion_tokens: 512,
    think: false,
  },
  providers: {
    groq: { min_request_interval_ms: 2200, max_retries: 5 },
    nvidia: { min_request_interval_ms: 2200, max_retries: 5 },
    ollama: { base_url: "http://localhost:11434", min_request_interval_ms: 0, max_retries: 2 },
  },
  langfuse: { base_url: "https://cloud.langfuse.com", environment: "development" },
};

/**
 * Levenshtein distance, used only to offer a "did you mean ...?" for a
 * rejected key.
 *
 * A positional character-by-character comparison is not good enough here: it
 * scores "max_retrries" vs "max_retries" as 6 errors and stays silent, even
 * though that is a two-character typo and exactly the case worth catching.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Offers the closest known key, if one is close enough to be a plausible typo. */
function suggest(key, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Two characters covers transpositions and dropped/duplicated letters
  // ("modle" -> "model", "max_retrries" -> "max_retries") without guessing wildly.
  return bestDistance <= 2 ? ` (did you mean "${best}"?)` : "";
}

/** Raises a readable, path-qualified error for anything the schema rejects. */
function fail(pathName, message) {
  throw new Error(`Invalid config at "${pathName}": ${message}`);
}

function validateType(value, expected, pathName) {
  if (expected === undefined) return;
  if (expected === "number" && typeof value !== "number") {
    fail(pathName, `expected a number, got ${JSON.stringify(value)}`);
  }
  if (expected === "boolean" && typeof value !== "boolean") {
    fail(pathName, `expected true or false (unquoted), got ${JSON.stringify(value)}`);
  }
  if (expected === "string" && typeof value !== "string") {
    fail(pathName, `expected a string, got ${JSON.stringify(value)}`);
  }
  if (expected === "list") {
    if (!Array.isArray(value)) {
      fail(pathName, `expected a list like [groq, ollama], got ${JSON.stringify(value)}`);
    }
    for (const entry of value) {
      if (typeof entry !== "string") {
        fail(pathName, `expected a list of strings, got ${JSON.stringify(value)}`);
      }
    }
  }
  if (expected === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    fail(pathName, `expected a mapping, got ${JSON.stringify(value)}`);
  }
}

/**
 * Validates an object against a fixed set of fields, rejecting unknown ones.
 *
 * This is the check dotenv cannot do. A mistyped key there is a line that is
 * read, ignored, and reported nowhere -- so `max_retrries: 5` looks like it
 * worked while changing nothing. Here it is an error naming the offending path.
 */
function validateFields(value, fields, pathName) {
  validateType(value, "object", pathName);

  for (const key of Object.keys(value)) {
    if (!(key in fields)) {
      throw new Error(
        `Invalid config at "${pathName}": unknown key "${key}".${suggest(key, Object.keys(fields))} ` +
          `Known keys: ${Object.keys(fields).join(", ")}`
      );
    }
  }

  for (const [key, sub] of Object.entries(fields)) {
    if (value[key] === undefined) continue;
    // A field is either a leaf type ("number") or a nested mapping, which has to
    // be validated recursively -- recursing only through leaves is what lets a
    // typo deep inside `providers.groq` slip through.
    if (typeof sub === "string") validateType(value[key], sub, `${pathName}.${key}`);
    else validateNode(value[key], sub, `${pathName}.${key}`);
  }
}

/**
 * Recursively validates a parsed document against the schema.
 *
 * A schema node is either a leaf type name ("string"), a fixed mapping
 * (`fields`), or a mapping with free-form keys that share one shape (`each`).
 */
function validateNode(value, schema, pathName) {
  if (typeof schema === "string") {
    validateType(value, schema, pathName);
    return;
  }

  if (schema.fields) {
    validateFields(value, schema.fields, pathName);
    return;
  }

  if (schema.each) {
    validateType(value, "object", pathName);
    for (const [key, body] of Object.entries(value)) {
      validateFields(body, schema.each, `${pathName}.${key}`);
    }
    return;
  }

  // A composite node: check any key we know about, and reject the rest.
  validateFields(value, schema, pathName);
}

/** Recursive merge; `source` wins for any key it defines. */
function merge(base, source) {
  if (source === undefined) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(source)) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && typeof out[key] === "object" && out[key] !== null
        ? merge(out[key], value)
        : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution

/** Reads `--profile <name>` / `--profile=<name>` from argv. */
export function parseProfileArg(argv = process.argv.slice(2)) {
  let profile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") profile = argv[i + 1];
    else if (argv[i].startsWith("--profile=")) profile = argv[i].slice("--profile=".length);
  }
  return profile;
}

function readConfigFile(path) {
  if (!existsSync(path)) {
    return { parsed: {}, missing: true };
  }
  let parsed;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${err.message}`);
  }
  if (parsed === null || parsed === undefined) return { parsed: {}, missing: false };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a mapping at the top level.`);
  }
  return { parsed, missing: false };
}

/**
 * Resolves the effective configuration: defaults, then the file, then the
 * selected profile, then anything already in process.env.
 *
 * The config path is resolved per call rather than at module load, so
 * EVAL_CONFIG can be changed between calls (which is how the tests point at
 * fixtures).
 *
 * @returns {{config: object, profile: string, source: string, warnings: string[]}}
 */
export function resolveConfig({ argv, env = process.env, path: configPath } = {}) {
  const path = configPath ?? env.EVAL_CONFIG ?? DEFAULT_CONFIG_PATH;
  const { parsed, missing } = readConfigFile(path);
  const warnings = [];

  validateNode(parsed, SCHEMA, basename(path));

  const requested = parseProfileArg(argv) ?? env.EVAL_PROFILE ?? parsed.profile;
  const profiles = parsed.profiles ?? {};

  if (requested && requested !== "default" && !(requested in profiles)) {
    throw new Error(
      `Unknown profile "${requested}". ${Object.keys(profiles).length ? `Available: ${Object.keys(profiles).join(", ")}.` : ""} ` +
        `Declare it under "profiles:" in ${basename(path)}, or pass --profile default.`
    );
  }

  const profileBody = requested && profiles[requested] ? profiles[requested] : {};
  // Validate the profile in isolation too, so a bad key inside a profile is
  // reported even when that profile is not the active one.
  validateNode(profileBody, PROFILE_SCHEMA, `profiles.${requested ?? "default"}`);

  let config = merge(merge(DEFAULTS, stripProfileKeys(parsed)), profileBody);
  config = applyEnvOverrides(config, env);

  return {
    config,
    profile: requested ?? "default",
    source: missing ? "built-in defaults (no config file)" : path,
    warnings,
  };
}

/** Last path segment, for short error messages. */
function basename(path) {
  return String(path).split(/[\\/]/).pop();
}

/** `profile`/`profiles` are resolution directives, not settings. */
function stripProfileKeys(parsed) {
  const { profile, profiles, ...rest } = parsed;
  return rest;
}

/**
 * Environment variables that override a setting.
 *
 * Written out explicitly rather than derived from SCHEMA: paths can be three
 * segments deep (`providers.groq.max_retries`), and deriving them by walking
 * the schema is exactly the kind of cleverness that quietly writes a number
 * over an object. Each entry also declares its own type, so the coercion here
 * and the validation there cannot drift apart.
 */
const ENV_OVERRIDES = [
  { var: "ENABLED_PROVIDERS", path: ["run", "enabled_providers"], type: "list" },
  { var: "JUDGE_PROVIDER", path: ["judge", "provider"], type: "string" },
  { var: "JUDGE_MODEL", path: ["judge", "model"], type: "string" },
  { var: "JUDGE_MAX_COMPLETION_TOKENS", path: ["judge", "max_completion_tokens"], type: "number" },
  { var: "JUDGE_THINK", path: ["judge", "think"], type: "boolean" },
  { var: "GROQ_MIN_REQUEST_INTERVAL_MS", path: ["providers", "groq", "min_request_interval_ms"], type: "number" },
  { var: "GROQ_MAX_RETRIES", path: ["providers", "groq", "max_retries"], type: "number" },
  { var: "NVIDIA_MIN_REQUEST_INTERVAL_MS", path: ["providers", "nvidia", "min_request_interval_ms"], type: "number" },
  { var: "NVIDIA_MAX_RETRIES", path: ["providers", "nvidia", "max_retries"], type: "number" },
  { var: "OLLAMA_BASE_URL", path: ["providers", "ollama", "base_url"], type: "string" },
  { var: "OLLAMA_MIN_REQUEST_INTERVAL_MS", path: ["providers", "ollama", "min_request_interval_ms"], type: "number" },
  { var: "OLLAMA_MAX_RETRIES", path: ["providers", "ollama", "max_retries"], type: "number" },
  { var: "LANGFUSE_BASE_URL", path: ["langfuse", "base_url"], type: "string" },
  { var: "LANGFUSE_TRACING_ENVIRONMENT", path: ["langfuse", "environment"], type: "string" },
  { var: "LANGFUSE_RELEASE", path: ["langfuse", "release"], type: "string" },
];

/** Writes a value at a nested path, creating intermediate objects as needed. */
function setPath(target, pathParts, value) {
  let node = target;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const key = pathParts[i];
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[pathParts[pathParts.length - 1]] = value;
}

/**
 * Environment variables win, so `ENABLED_PROVIDERS=ollama yarn eval` still
 * works. Only variables that are actually set are consulted.
 */
function applyEnvOverrides(config, env) {
  const out = structuredClone(config);

  for (const { var: varName, path, type } of ENV_OVERRIDES) {
    const raw = env[varName];
    if (raw === undefined) continue;

    if (type === "list") {
      setPath(out, path, raw.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid config: ${varName}=${JSON.stringify(raw)} is not a number.`);
      }
      setPath(out, path, value);
    } else if (type === "boolean") {
      setPath(out, path, raw === "true");
    } else {
      setPath(out, path, raw);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Projection into process.env
//
// Every module below config.js still reads process.env, and the Langfuse SDK
// reads it directly, so resolved values are written there. `if (!key in env)`
// keeps the override precedence intact: a real environment variable is never
// clobbered by the file.

const PROJECTION = [
  ["ENABLED_PROVIDERS", (c) => c.run.enabled_providers.join(",")],
  ["JUDGE_PROVIDER", (c) => c.judge.provider],
  ["JUDGE_MODEL", (c) => c.judge.model],
  ["JUDGE_MAX_COMPLETION_TOKENS", (c) => String(c.judge.max_completion_tokens)],
  ["JUDGE_THINK", (c) => String(c.judge.think)],
  ["GROQ_MIN_REQUEST_INTERVAL_MS", (c) => String(c.providers.groq.min_request_interval_ms)],
  ["GROQ_MAX_RETRIES", (c) => String(c.providers.groq.max_retries)],
  ["NVIDIA_MIN_REQUEST_INTERVAL_MS", (c) => String(c.providers.nvidia.min_request_interval_ms)],
  ["NVIDIA_MAX_RETRIES", (c) => String(c.providers.nvidia.max_retries)],
  ["OLLAMA_BASE_URL", (c) => c.providers.ollama.base_url],
  ["OLLAMA_MIN_REQUEST_INTERVAL_MS", (c) => String(c.providers.ollama.min_request_interval_ms)],
  ["OLLAMA_MAX_RETRIES", (c) => String(c.providers.ollama.max_retries)],
  ["LANGFUSE_BASE_URL", (c) => c.langfuse.base_url],
  ["LANGFUSE_TRACING_ENVIRONMENT", (c) => c.langfuse.environment],
  ["LANGFUSE_RELEASE", (c) => c.langfuse.release],
];

/** Writes resolved values into process.env without overwriting real overrides. */
export function projectToEnv(config, env = process.env) {
  for (const [key, read] of PROJECTION) {
    const value = read(config);
    if (value === undefined || value === null || value === "") continue;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

/**
 * The resolved configuration for this process.
 *
 * Importing this module resolves the config, validates it, and projects it into
 * process.env as a side effect. That side effect is the point: everything
 * downstream (including the Langfuse SDK) keeps reading process.env, so no
 * other module had to change.
 *
 * It must therefore be imported BEFORE instrumentation.js, which reads
 * LANGFUSE_* at import time.
 */
const resolved = resolveConfig();
projectToEnv(resolved.config);

export const config = resolved.config;
export const profile = resolved.profile;
export const configSource = resolved.source;
export const configWarnings = resolved.warnings;