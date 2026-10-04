/**
 * A small JSON Schema validator covering the subset that matters here:
 * type, required, properties, items, enum, additionalProperties.
 *
 * Why this exists: when a prompt demands "return one compact JSON object with
 * exactly this structure, no Markdown", the objective question is whether the
 * output conforms. An LLM judge is a poor instrument for that -- it reads
 * prose and gives it a 4/5 even when the braces are wrong. A deterministic 0/1
 * is free, exact, and reproducible, so it runs alongside the judge rather than
 * instead of it. The README already suggests adding deterministic scorers; this
 * is the first one.
 *
 * Deliberately dependency-free and deliberately not a general implementation:
 * unsupported keywords are ignored rather than treated as failures, so an
 * unusual schema degrades to "checks what it can" instead of false negatives.
 */

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

function typeMatches(value, type) {
  const check = TYPE_CHECKS[type];
  if (!check) return true; // unknown type keyword: don't invent a failure
  return check(value);
}

/**
 * Validates a parsed value against a JSON Schema subset.
 *
 * @param {*} value - the parsed JSON value.
 * @param {object} schema - a JSON Schema (object).
 * @param {string} [path] - JSON pointer-ish path used in error messages.
 * @returns {{valid: boolean, errors: string[], checked: number, passed: number}}
 *   `checked`/`passed` count leaf constraints actually evaluated, which lets a
 *   caller report partial coverage instead of implying full validation.
 */
export function validate(value, schema, path = "$") {
  const errors = [];
  const stats = { checked: 0, passed: 0 };

  const walk = (val, sch, at) => {
    if (!sch || typeof sch !== "object") return;

    if (sch.type) {
      const types = Array.isArray(sch.type) ? sch.type : [sch.type];
      stats.checked++;
      if (types.some((t) => typeMatches(val, t))) {
        stats.passed++;
      } else {
        errors.push(`${at}: expected ${types.join("|")}, got ${Array.isArray(val) ? "array" : val === null ? "null" : typeof val}`);
        return; // don't descend into a value of the wrong shape
      }
    }

    if (Array.isArray(sch.enum)) {
      stats.checked++;
      if (sch.enum.includes(val)) stats.passed++;
      else errors.push(`${at}: ${JSON.stringify(val)} is not one of ${JSON.stringify(sch.enum)}`);
    }

    if (typeMatches(val, "object")) {
      for (const key of sch.required ?? []) {
        stats.checked++;
        if (Object.hasOwn(val, key) && val[key] !== undefined) {
          stats.passed++;
        } else {
          errors.push(`${at}.${key}: required property is missing`);
        }
      }

      if (sch.additionalProperties === false) {
        const known = new Set(Object.keys(sch.properties ?? {}));
        for (const key of Object.keys(val)) {
          if (!known.has(key)) errors.push(`${at}.${key}: unexpected property`);
        }
      }

      for (const [key, sub] of Object.entries(sch.properties ?? {})) {
        if (Object.hasOwn(val, key) && val[key] !== undefined) walk(val[key], sub, `${at}.${key}`);
      }
    }

    if (Array.isArray(val) && sch.items) {
      val.forEach((item, i) => walk(item, sch.items, `${at}[${i}]`));
    }
  };

  walk(value, schema, path);
  return { valid: errors.length === 0, errors, ...stats };
}

/**
 * Parses model output that is supposed to be a single JSON object, tolerating
 * the two things models actually do: wrap it in a ```json fence, and add a
 * sentence of preamble or commentary.
 *
 * @returns {{ok: true, value: *} | {ok: false, error: string, raw: string}}
 */
export function parseJsonLoose(text) {
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();

  if (trimmed === "") return { ok: false, error: "empty response", raw };

  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  // Fall back to the outermost {...} or [...] span, for prose-wrapped output.
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const closer = trimmed[start] === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(closer);
    if (end > start) candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      /* try the next shape */
    }
  }

  return { ok: false, error: "output is not parseable JSON", raw };
}

/**
 * Scores a model response against the prompt's JSON schema, deterministically.
 *
 * @param {string} text - raw model output.
 * @param {object} schema - the JSON Schema the prompt asked for.
 * @returns {{value: number, comment: string, parsed: boolean}}
 *   `value` is 1 when the output parses AND conforms, else 0.
 */
export function scoreAgainstSchema(text, schema) {
  const parsed = parseJsonLoose(text);

  if (!parsed.ok) {
    return {
      value: 0,
      parsed: false,
      comment: `Not parseable as JSON: ${parsed.error}. First 200 chars: ${parsed.raw.slice(0, 200)}`,
    };
  }

  const result = validate(parsed.value, schema);

  if (result.valid) {
    return {
      value: 1,
      parsed: true,
      comment: `Valid JSON matching the schema (${result.passed}/${result.checked} constraints checked).`,
    };
  }

  return {
    value: 0,
    parsed: true,
    comment: `Valid JSON but does not match the schema (${result.errors.length} problem(s), ${result.passed}/${result.checked} constraints passed): ${result.errors.join("; ")}`,
  };
}

/**
 * Lists the top-level required fields of a schema, for use in judge criteria.
 */
export function describeSchema(schema) {
  if (!schema || schema.type !== "object" || !schema.properties) return null;
  return Object.keys(schema.properties ?? {});
}