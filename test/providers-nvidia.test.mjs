import "./helpers/env.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import { callModel, normalizeModel, providersSupporting } from "../src/providers/index.js";

/** Stubs fetch for one call and returns the JSON body the client sent. */
async function captureBody(params) {
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, options = {}) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  };
  try {
    await callModel(params);
    return sent;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ------------------------------------------------------------- per-model params

test("normalizeModel: extra entry keys become params, id/provider stay top-level", () => {
  assert.deepEqual(
    normalizeModel({
      id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      provider: "nvidia",
      reasoning_effort: "max",
    }),
    {
      id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      provider: "nvidia",
      params: { reasoning_effort: "max" },
    }
  );
});

test("normalizeModel: a plain entry keeps the exact { id, provider } shape", () => {
  // No empty `params` key: existing callers and tests rely on this shape.
  assert.deepEqual(normalizeModel({ id: "meta/llama-3.2-11b-vision-instruct", provider: "nvidia" }), {
    id: "meta/llama-3.2-11b-vision-instruct",
    provider: "nvidia",
  });
  assert.deepEqual(normalizeModel("allam-2-7b"), { id: "allam-2-7b", provider: "groq" });
});

// ------------------------------------------------------------ reasoning_effort

test("callModel(nvidia): forwards reasoning_effort in the request body", async () => {
  const body = await captureBody({
    provider: "nvidia",
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    messages: [{ role: "user", content: "What is in this image?" }],
    max_completion_tokens: 16384,
    reasoning_effort: "max",
  });

  assert.equal(body.reasoning_effort, "max");
  // max_completion_tokens is still translated to NVIDIA's max_tokens name.
  assert.equal(body.max_tokens, 16384);
  assert.equal(body.model, "nvidia/nemotron-3.5-super-vl-120b-a12b");
});

test("callModel(nvidia): omits reasoning_effort when not supplied", async () => {
  const body = await captureBody({
    provider: "nvidia",
    model: "meta/llama-3.2-11b-vision-instruct",
    messages: [{ role: "user", content: "ping" }],
  });

  assert.ok(!("reasoning_effort" in body), "field must be absent, not null");
});

test("providersSupporting: reasoning_effort is an NVIDIA-only parameter", () => {
  assert.deepEqual(providersSupporting("reasoning_effort"), ["nvidia"]);
});
