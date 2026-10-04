import "./helpers/env.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { imageDataUrl, mimeTypeFor, toDataUrl, isDataUrl, describeDataUrl, resolveAssetPath } from "../src/images.js";
import { loadPromptRequest, extractOllamaImagePaths, toResponseFormat } from "../src/promptRequest.js";
import { validate, parseJsonLoose, scoreAgainstSchema } from "../src/jsonSchema.js";

// ------------------------------------------------------------------- images.js

test("mimeTypeFor: maps the formats providers actually accept", () => {
  assert.equal(mimeTypeFor("a.jpg"), "image/jpeg");
  assert.equal(mimeTypeFor("a.JPEG"), "image/jpeg");
  assert.equal(mimeTypeFor("a.png"), "image/png");
  assert.equal(mimeTypeFor("a.webp"), "image/webp");
  assert.equal(mimeTypeFor("a.txt"), "application/octet-stream");
});

test("imageDataUrl: reads a binary file and base64-encodes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pme-img-"));
  try {
    // PNG magic bytes -- the exact bytes must survive the round trip.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    writeFileSync(join(dir, "t.png"), bytes);

    const url = imageDataUrl(join(dir, "t.png"));
    assert.ok(url.startsWith("data:image/png;base64,"));
    const decoded = Buffer.from(url.split(",")[1], "base64");
    assert.deepEqual(decoded, bytes, "binary content must round-trip exactly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("imageDataUrl: enforces the size guard before reading", () => {
  const dir = mkdtempSync(join(tmpdir(), "pme-img-"));
  try {
    writeFileSync(join(dir, "big.png"), Buffer.alloc(4096));
    assert.throws(() => imageDataUrl(join(dir, "big.png"), { maxBytes: 1024 }), /over the/);
    assert.doesNotThrow(() => imageDataUrl(join(dir, "big.png"), { maxBytes: 8192 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("imageDataUrl: reports a helpful error listing where it looked", () => {
  assert.throws(() => imageDataUrl("does/not/exist.png"), /Image not found[\s\S]*does\/not\/exist\.png/);
});

test("imageDataUrl: resolves repo-relative paths", () => {
  const url = imageDataUrl("src/assets/images/simple-test.png");
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.ok(url.length > 1000);
});

test("toDataUrl / isDataUrl: data URLs pass through, paths are read", () => {
  assert.equal(isDataUrl("data:image/png;base64,AAA"), true);
  assert.equal(isDataUrl("/tmp/x.png"), false);
  assert.equal(toDataUrl("data:image/png;base64,AAA"), "data:image/png;base64,AAA");
  assert.ok(toDataUrl("src/assets/images/simple-test.png").startsWith("data:image/png;base64,"));
  assert.throws(() => toDataUrl(42), /Unsupported image value/);
});

test("describeDataUrl: reports the decoded size", () => {
  assert.match(describeDataUrl("data:image/png;base64," + "A".repeat(400)), /KB/);
});

test("resolveAssetPath: prefers an existing file over throwing", () => {
  assert.ok(resolveAssetPath("src/assets/images/simple-test.png").endsWith("simple-test.png"));
});

// ------------------------------------------------------------- promptRequest.js

test("extractOllamaImagePaths: decodes the base64-wrapped path template", () => {
  const path = "C:\\Users\\someone\\frames\\frame_000001.jpg";
  const encoded = Buffer.from(path, "utf8").toString("base64");
  const expr = `\${[ fs.readFile(path=b64'${encoded}', encoding='base64') ]}`;
  assert.deepEqual(extractOllamaImagePaths(expr), [path]);
});

test("loadPromptRequest: maps the captured Ollama request onto OpenAI params", () => {
  const request = loadPromptRequest("src/datasets/complex_prompt.md");

  assert.match(request.prompt, /compact JSON object/);
  assert.equal(request.schema.type, "object");
  assert.ok(request.schema.properties.summary);
  assert.ok(request.schema.properties.visible_posture);
  assert.equal(request.options.temperature, 0.8, "temperature maps straight across");
  assert.equal(
    request.options.max_completion_tokens,
    8192,
    "Ollama num_predict maps to max_completion_tokens"
  );
  assert.ok(
    request.warnings.some((w) => w.includes("repeat_penalty")),
    "an unmappable option must be reported, not silently dropped"
  );
  assert.ok(
    request.referencedImages.some((p) => p.includes("video-to-practice")),
    "the stale external image path is surfaced, not hidden"
  );
});

test("toResponseFormat: produces an OpenAI json_schema spec with a name", () => {
  const rf = toResponseFormat({ type: "object", properties: { a: { type: "string" } } });
  assert.equal(rf.type, "json_schema");
  assert.equal(rf.json_schema.name, "eval_response");
  assert.equal(rf.json_schema.schema.type, "object");
  assert.equal(toResponseFormat(null), undefined, "no schema means no response_format");
});

// ----------------------------------------------------------------- jsonSchema.js

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "number" },
    points: { type: "array", items: { type: "string" } },
    nested: {
      type: "object",
      properties: { stance: { type: "string" } },
      required: ["stance"],
    },
  },
  required: ["summary", "confidence", "points", "nested"],
};

test("validate: accepts a fully conformant value", () => {
  const result = validate(
    { summary: "s", confidence: 0.9, points: ["a"], nested: { stance: "wide" } },
    SCHEMA
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validate: reports each missing required field", () => {
  const result = validate({ summary: "s" }, SCHEMA);
  assert.equal(result.valid, false);
  assert.equal(result.errors.filter((e) => e.includes("required property is missing")).length, 3);
});

test("validate: catches wrong types, including number-vs-integer", () => {
  assert.equal(validate({ ...base(), confidence: "high" }, SCHEMA).valid, false);
  assert.equal(validate({ ...base(), confidence: NaN }, SCHEMA).valid, false);
  assert.equal(validate({ ...base(), points: "not an array" }, SCHEMA).valid, false);
  assert.equal(validate({ ...base(), points: [1, 2] }, SCHEMA).valid, false);
  assert.equal(validate({ ...base(), nested: [] }, SCHEMA).valid, false);
});

function base() {
  return { summary: "s", confidence: 0.5, points: [], nested: { stance: "x" } };
}

test("validate: does not descend into a value of the wrong shape", () => {
  const result = validate({ ...base(), summary: 42 }, SCHEMA);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1, "one error, not a cascade");
});

test("validate: unknown schema keywords are ignored rather than failing", () => {
  const weird = { type: "object", properties: { a: { type: "string", pattern: "^x$" } } };
  assert.equal(validate({ a: "anything" }, weird).valid, true);
});

test("parseJsonLoose: handles clean, fenced and prose-wrapped JSON", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonLoose('```\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":1} hope that helps'), {
    ok: true,
    value: { a: 1 },
  });
  assert.deepEqual(parseJsonLoose("[1,2]"), { ok: true, value: [1, 2] });
});

test("parseJsonLoose: refuses junk and empty output", () => {
  assert.equal(parseJsonLoose("not json at all").ok, false);
  assert.equal(parseJsonLoose("").ok, false);
  assert.equal(parseJsonLoose("   ").ok, false);
  assert.equal(parseJsonLoose(undefined).ok, false);
});

test("scoreAgainstSchema: 1 only when the output parses AND conforms", () => {
  assert.equal(scoreAgainstSchema('{"a":1}', { type: "object" }).value, 1);

  const unparseable = scoreAgainstSchema("I'm afraid I can't do that", SCHEMA);
  assert.equal(unparseable.value, 0);
  assert.equal(unparseable.parsed, false);
  assert.match(unparseable.comment, /Not parseable/);

  const nonconformant = scoreAgainstSchema('{"summary":"s"}', SCHEMA);
  assert.equal(nonconformant.value, 0);
  assert.equal(nonconformant.parsed, true);
  assert.match(nonconformant.comment, /does not match the schema/);

  const conformant = scoreAgainstSchema(JSON.stringify(base()), SCHEMA);
  assert.equal(conformant.value, 1);
  assert.match(conformant.comment, /constraints checked/);
});

test("scoreAgainstSchema: a fenced but conformant response still scores 1", () => {
  const output = "```json\n" + JSON.stringify(base()) + "\n```";
  assert.equal(scoreAgainstSchema(output, SCHEMA).value, 1);
});

test("scoreAgainstSchema: tolerates the real prompt's schema shape", () => {
  const schema = loadPromptRequest("src/datasets/complex_prompt.md").schema;
  const good = {
    summary: "a person mid-stance",
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
      possible_posture_or_transition: "warding",
      apparent_intent: "balancing",
      technical_points: ["relaxed shoulders"],
    },
    limitations: ["single frame"],
    confidence: 0.7,
  };

  assert.equal(scoreAgainstSchema(JSON.stringify(good), schema).value, 1);

  // Drop one required leaf and it must fail.
  const bad = structuredClone(good);
  delete bad.visible_posture.foot_position;
  const result = scoreAgainstSchema(JSON.stringify(bad), schema);
  assert.equal(result.value, 0);
  assert.match(result.comment, /foot_position/);

  // The array-of-strings constraint must be enforced too.
  const bad2 = structuredClone(good);
  bad2.taiji_context.technical_points = "not an array";
  assert.equal(scoreAgainstSchema(JSON.stringify(bad2), schema).value, 0);
});