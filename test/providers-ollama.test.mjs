import "./helpers/env.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLoopbackEndpoint,
  ollamaLocality,
  toOllamaMessages,
  toOllamaFormat,
  listOllamaModelIds,
  listOllamaModelDetails,
} from "../src/providers/ollama.js";
import { callModel, normalizeModel, providersSupporting, PROVIDERS } from "../src/providers/index.js";

const JPEG_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD//2Q==";

// -------------------------------------------------- images: the important bit

test("toOllamaMessages: strips the data-URL prefix from images", () => {
  // The single most important translation: Ollama wants BARE base64 in a
  // separate `images` array. Handing it the OpenAI `image_url` data URL is the
  // natural-looking mistake and fails server-side with an opaque decode error.
  const out = toOllamaMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` } },
      ],
    },
  ]);

  assert.equal(out[0].role, "user");
  assert.equal(out[0].content, "what is this?");
  assert.deepEqual(out[0].images, [JPEG_B64]);
  assert.ok(!out[0].images[0].startsWith("data:"), "prefix must be gone");
  assert.ok(!out[0].images[0].includes(","), "no data-URL comma may survive");
});

test("toOllamaMessages: accepts several images and preserves order", () => {
  const out = toOllamaMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "compare" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
      ],
    },
  ]);
  assert.deepEqual(out[0].images, ["AAA", "BBB"]);
});

test("toOllamaMessages: plain string messages pass through untouched", () => {
  const out = toOllamaMessages([{ role: "user", content: "ping" }]);
  assert.deepEqual(out, [{ role: "user", content: "ping" }]);
  assert.ok(!("images" in out[0]), "no empty images array for text-only prompts");
});

test("toOllamaMessages: already-bare base64 is left alone", () => {
  const out = toOllamaMessages([
    { role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: JPEG_B64 } }] },
  ]);
  assert.deepEqual(out[0].images, [JPEG_B64]);
});

test("toOllamaMessages: multiple text parts are joined", () => {
  const out = toOllamaMessages([
    { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
  ]);
  assert.equal(out[0].content, "one\ntwo");
});

// -------------------------------------------------------- structured output

test("toOllamaFormat: unwraps a full JSON Schema, which the OpenAI shim cannot do", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const out = toOllamaFormat({ type: "json_schema", json_schema: { name: "x", schema } });
  assert.deepEqual(out, schema, "Ollama takes the bare schema, not the OpenAI wrapper");
});

test("toOllamaFormat: json_object maps to Ollama's \"json\"", () => {
  assert.equal(toOllamaFormat({ type: "json_object" }), "json");
});

test("toOllamaFormat: no response_format means no constraint", () => {
  assert.equal(toOllamaFormat(undefined), undefined);
  assert.equal(toOllamaFormat(null), undefined);
});

// ------------------------------------------------------- option translation

test("callModel: maps harness params onto Ollama's native request body", async () => {
  const realFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (url, options = {}) => {
    body = { url: String(url), payload: JSON.parse(options.body) };
    return new Response(
      JSON.stringify({
        message: { role: "assistant", content: '{"a":1}' },
        prompt_eval_count: 30,
        eval_count: 7,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const result = await callModel({
      provider: "ollama",
      model: "qwen3-vl:2b",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.8,
      max_completion_tokens: 8192,
      repeat_penalty: 1.15,
      think: false,
      response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } },
    });

    assert.ok(body.url.endsWith("/api/chat"), "native endpoint, not the OpenAI shim");
    assert.equal(body.payload.stream, false);
    assert.equal(body.payload.options.num_predict, 8192, "max_completion_tokens -> num_predict");
    assert.equal(body.payload.options.temperature, 0.8);
    assert.equal(body.payload.options.repeat_penalty, 1.15, "native-only option survives");
    assert.equal(body.payload.think, false, "native-only switch survives");
    assert.deepEqual(body.payload.format, { type: "object" });

    // Usage must be normalized or Langfuse session cost silently reads zero.
    assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 });
    assert.equal(result.content, '{"a":1}');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("callModel: omits options/format entirely when unset", async () => {
  const realFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (url, options = {}) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
  };

  try {
    await callModel({ provider: "ollama", model: "llava:latest", messages: [{ role: "user", content: "hi" }] });
    assert.ok(!("options" in body), "no empty options object");
    assert.ok(!("format" in body), "no empty format");
    assert.ok(!("think" in body), "no empty think");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("callModel: surfaces a thinking pass separately from content", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ message: { content: "final", thinking: "hmm..." }, prompt_eval_count: 1, eval_count: 2 }),
      { status: 200 }
    );
  try {
    const result = await callModel({ provider: "ollama", model: "qwen3-vl:2b", messages: [{ role: "user", content: "x" }] });
    assert.equal(result.content, "final");
    assert.equal(result.thinking, "hmm...");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("callModel: explains a connection failure in terms of `ollama serve`", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    // No API key to be wrong about, so the only useful error is "not running".
    // The throttle retries transport errors, so this surfaces only after they
    // are exhausted.
    await assert.rejects(
      () => callModel({ provider: "ollama", model: "qwen3-vl:2b", messages: [{ role: "user", content: "x" }] }),
      /fetch failed/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("callModel: a 404 from Ollama names the base URL and the fix", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("model not found", { status: 404 });
  try {
    await assert.rejects(
      () => callModel({ provider: "ollama", model: "nope:latest", messages: [{ role: "user", content: "x" }] }),
      /ollama pull nope:latest[\s\S]*OLLAMA_BASE_URL/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------ model listing

test("listOllamaModelIds: reads /api/tags and collects both name and model", async () => {
  const realFetch = globalThis.fetch;
  let url = null;
  globalThis.fetch = async (u) => {
    url = String(u);
    return new Response(
      JSON.stringify({ models: [{ name: "qwen3-vl:2b", model: "qwen3-vl:2b" }, { name: "llava:latest" }] }),
      { status: 200 }
    );
  };
  try {
    const ids = await listOllamaModelIds();
    assert.ok(url.endsWith("/api/tags"));
    assert.ok(ids.has("qwen3-vl:2b"));
    assert.ok(ids.has("llava:latest"), "entries with only `name` are still collected");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("listOllamaModelDetails: reports vision and thinking capability", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        models: [
          { model: "qwen3-vl:2b", capabilities: ["completion", "vision", "thinking"] },
          { model: "text-only:1b", capabilities: ["completion"] },
        ],
      }),
      { status: 200 }
    );
  try {
    const details = await listOllamaModelDetails();
    assert.deepEqual(details.find((d) => d.id === "qwen3-vl:2b"), {
      id: "qwen3-vl:2b",
      vision: true,
      thinking: true,
    });
    assert.equal(details.find((d) => d.id === "text-only:1b").vision, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------ unsupported params

test("providersSupporting: reports which providers implement native-only params", () => {
  assert.deepEqual(providersSupporting("repeat_penalty"), ["ollama"]);
  assert.deepEqual(providersSupporting("think"), ["ollama"]);
  assert.ok(providersSupporting("response_format").includes("groq"));
  assert.ok(providersSupporting("response_format").includes("ollama"));
});

test("callModel: warns once when a provider is handed a parameter it cannot use", async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });

  try {
    for (let i = 0; i < 3; i++) {
      await callModel({
        provider: "groq",
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: "x" }],
        repeat_penalty: 1.15,
      });
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }

  const relevant = warnings.filter((w) => w.includes("repeat_penalty"));
  assert.equal(relevant.length, 1, "warns once, not once per call");
  assert.match(relevant[0], /Groq does not support "repeat_penalty"/);
});

// ------------------------------------------------------------------ registry

test("registry: ollama is registered with its optional capability lister", () => {
  assert.ok(PROVIDERS.ollama);
  assert.equal(PROVIDERS.ollama.label, "Ollama (local)");
  assert.equal(typeof PROVIDERS.ollama.listModelDetails, "function");
  assert.equal(PROVIDERS.groq.listModelDetails, undefined, "no phantom lister on groq");
});

test("normalizeModel: bare strings still default to Groq", () => {
  assert.deepEqual(normalizeModel("allam-2-7b"), { id: "allam-2-7b", provider: "groq" });
  assert.deepEqual(normalizeModel({ id: "qwen3-vl:2b", provider: "ollama" }), {
    id: "qwen3-vl:2b",
    provider: "ollama",
  });
});
// --------------------------------------------------------------- truncation

test("callModel: reports done_reason 'length' as truncation", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        message: { content: '{"summary": "half a resp' },
        done_reason: "length",
        prompt_eval_count: 2300,
        eval_count: 5800,
      }),
      { status: 200 }
    );
  try {
    const result = await callModel({
      provider: "ollama",
      model: "qwen3-vl:2b",
      messages: [{ role: "user", content: "x" }],
    });
    assert.equal(result.truncated, true);
    assert.equal(result.doneReason, "length");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("callModel: a normal 'stop' finish is not truncation", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: { content: "done" }, done_reason: "stop" }), { status: 200 });
  try {
    const result = await callModel({ provider: "ollama", model: "llava:latest", messages: [{ role: "user", content: "x" }] });
    assert.equal(result.truncated, false);
    assert.equal(result.doneReason, "stop");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("callModel: no done_reason at all is reported as not-truncated, not guessed", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
  try {
    const result = await callModel({ provider: "ollama", model: "x:1b", messages: [{ role: "user", content: "x" }] });
    assert.equal(result.truncated, false);
    assert.equal(result.doneReason, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------- judge on Ollama

/** Loads a fresh judge.js with the given env, since it reads config at import. */
async function loadJudge(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const module = await import(`../src/judge.js?t=${Math.random()}`);
  return {
    ...module,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

async function captureJudgeCall(env, reply) {
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, options = {}) => {
    sent = JSON.parse(options.body);
    return new Response(
      JSON.stringify(reply ?? { message: { content: '{"score":4,"reasoning":"ok"}' }, done_reason: "stop" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const mod = await loadJudge(env);
  try {
    const judged = await mod.judgeOutput({ input: "i", output: "o", criteria: "c" });
    return { sent, judged, mod };
  } finally {
    globalThis.fetch = realFetch;
    mod.restore();
  }
}

test("judge: suppresses thinking on Ollama and uses a workable budget", async () => {
  // The regression this guards: with thinking on, the judge burned its whole
  // output budget reasoning out loud, got truncated at `length`, and every item
  // scored UNSCORED for a reason that had nothing to do with the model.
  const { sent, judged, mod } = await captureJudgeCall({
    JUDGE_PROVIDER: "ollama",
    JUDGE_MODEL: "qwen3.8:27b",
    JUDGE_THINK: undefined,
    JUDGE_MAX_COMPLETION_TOKENS: undefined,
  });

  assert.equal(sent.think, false, "judge must not think out loud by default");
  assert.equal(sent.options.num_predict, 512, "default budget raised from 300");
  assert.equal(judged.score, 4);
  assert.equal(mod.JUDGE_MAX_COMPLETION_TOKENS, 512);
});

test("judge: JUDGE_THINK=true opts back into reasoning", async () => {
  const { sent } = await captureJudgeCall({
    JUDGE_PROVIDER: "ollama",
    JUDGE_MODEL: "qwen3.8:27b",
    JUDGE_THINK: "true",
  });
  assert.equal(sent.think, true);
});

test("judge: JUDGE_MAX_COMPLETION_TOKENS is honoured", async () => {
  const { sent } = await captureJudgeCall({
    JUDGE_PROVIDER: "ollama",
    JUDGE_MODEL: "qwen3.8:27b",
    JUDGE_MAX_COMPLETION_TOKENS: "1500",
  });
  assert.equal(sent.options.num_predict, 1500);
});

test("judge: omits `think` entirely for providers without that switch", async () => {
  const { sent } = await captureJudgeCall({
    JUDGE_PROVIDER: "groq",
    JUDGE_MODEL: "openai/gpt-oss-20b",
    JUDGE_THINK: undefined,
  });
  assert.ok(!("think" in sent), "groq has no thinking control; do not invent one");
});

test("judge: a truncated verdict is reported as truncation, not as bad JSON", async () => {
  // These have different fixes (raise the budget / disable thinking vs. fix the
  // prompt), so they must not collapse into the same "failed to parse" message.
  const { judged } = await captureJudgeCall(
    { JUDGE_PROVIDER: "ollama", JUDGE_MODEL: "qwen3.8:27b" },
    { message: { content: "We are given a task to" }, done_reason: "length" }
  );
  assert.equal(judged.score, null);
  assert.match(judged.reasoning, /truncated at 512 tokens/);
  assert.match(judged.reasoning, /JUDGE_MAX_COMPLETION_TOKENS/);
  assert.doesNotMatch(judged.reasoning, /Failed to parse/);
});

// ---------------------------------------------------------------- locality

test("isLoopbackEndpoint: recognises the usual local spellings", () => {
  for (const url of [
    "http://localhost:11434",
    "http://LOCALHOST:11434",
    "http://127.0.0.1:11434",
    "http://127.1.2.3:11434",
    "http://[::1]:11434",
    "http://0.0.0.0:11434",
    "http://ollama.localhost:11434",
  ]) {
    assert.equal(isLoopbackEndpoint(url), true, url);
  }
});

test("isLoopbackEndpoint: anything else is remote", () => {
  // Ollama can point at a shared GPU box, so an address that is merely
  // "not localhost" must not be reported as local.
  for (const url of [
    "http://gpu-box.lan:11434",
    "https://ollama.example.com",
    "http://10.0.0.5:11434",
    "http://192.168.1.50:11434",
    "http://[2001:db8::1]:11434",
  ]) {
    assert.equal(isLoopbackEndpoint(url), false, url);
  }
});

test("isLoopbackEndpoint: unparseable input is remote, not a false 'local' claim", () => {
  assert.equal(isLoopbackEndpoint("not a url"), false);
  assert.equal(isLoopbackEndpoint(""), false);
});

test("provider labels distinguish local from remote ollama", async () => {
  const local = await import("../src/providers/index.js?loc=1");
  assert.equal(local.PROVIDERS.ollama.label, "Ollama (local)");
  assert.equal(local.providerTag("ollama"), "ollama/local");
  assert.equal(local.providerEndpoint("ollama"), "http://localhost:11434");
});

test("hosted providers carry no locality suffix (they are always remote)", async () => {
  const p = await import("../src/providers/index.js?loc=2");
  assert.equal(p.providerTag("groq"), "groq");
  assert.equal(p.providerTag("nvidia"), "nvidia");
  assert.equal(p.providerEndpoint("groq"), undefined);
  assert.equal(p.providerLabel("groq"), "Groq");
});

test("a remote OLLAMA_BASE_URL flips the label to remote", async () => {
  const saved = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://gpu-box.lan:11434";
  try {
    // Re-import with a distinct query so the module re-evaluates against the
    // new endpoint. Its dependencies are cached, but the ollama client reads
    // the base URL from env at evaluation time.
    const remote = await import("../src/providers/ollama.js?remote=1");
    assert.equal(remote.ollamaLocality(), "remote");
    assert.equal(remote.isLoopbackEndpoint(), false);
    assert.equal(remote.OLLAMA_BASE_URL, "http://gpu-box.lan:11434");
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
  }
});
