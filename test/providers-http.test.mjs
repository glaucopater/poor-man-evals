import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRetryAfter, numFromEnv, createThrottledFetch } from "../src/providers/http.js";

// --------------------------------------------------------------- parseRetryAfter

test("parseRetryAfter: delay-seconds form", () => {
  assert.equal(parseRetryAfter("30"), 30_000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("2.5"), 2_500);
});

test("parseRetryAfter: HTTP-date form resolves against the clock", () => {
  // The bug this guards: Number("Wed, 21 Oct 2015 07:28:00 GMT") is NaN, so the
  // backoff sleep became a no-op at the exact moment the provider asked us to
  // wait.
  const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:30 GMT", now), 30_000);
});

test("parseRetryAfter: dates in the past clamp to zero, never negative", () => {
  const now = Date.parse("Wed, 21 Oct 2015 07:29:00 GMT");
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now), 0);
});

test("parseRetryAfter: absent or garbage headers fall back to exponential backoff", () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("   "), null);
  assert.equal(parseRetryAfter("soon-ish"), null);
});

// --------------------------------------------------------------------- numFromEnv

test("numFromEnv: falls back on unset, blank and non-numeric values", () => {
  assert.equal(numFromEnv("PME_TEST_UNSET", 2200), 2200);

  process.env.PME_TEST_BLANK = "   ";
  assert.equal(numFromEnv("PME_TEST_BLANK", 2200), 2200);

  process.env.PME_TEST_GARBAGE = "abc"; // e.g. GROQ_MAX_RETRIES=abc
  assert.equal(numFromEnv("PME_TEST_GARBAGE", 5), 5);

  process.env.PME_TEST_NUMERIC = "0";
  assert.equal(numFromEnv("PME_TEST_NUMERIC", 5), 0);

  delete process.env.PME_TEST_BLANK;
  delete process.env.PME_TEST_GARBAGE;
  delete process.env.PME_TEST_NUMERIC;
});

// ---------------------------------------------------------- createThrottledFetch

test("createThrottledFetch: rejects invalid configuration up front", () => {
  assert.throws(() => createThrottledFetch({ label: "x", minIntervalMs: NaN, maxRetries: 1 }));
  assert.throws(() => createThrottledFetch({ label: "x", minIntervalMs: -1, maxRetries: 1 }));
  assert.throws(() => createThrottledFetch({ label: "x", minIntervalMs: 0, maxRetries: NaN }));
});

test("createThrottledFetch: honours a date-form Retry-After instead of firing immediately", async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const started = Date.now();
  const waits = [];
  console.warn = (msg) => waits.push(msg);

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response("{}", {
        status: 429,
        headers: { "retry-after": new Date(Date.now() + 300).toISOString() },
      });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const throttled = createThrottledFetch({ label: "Test", minIntervalMs: 0, maxRetries: 3 });
    const res = await throttled("https://example.test/x");

    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 250, "should have waited ~300ms before retrying");
    assert.match(waits[0], /Rate limited by Test \(429\)\. Waiting 0\.3s before retry 1\/3/);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});

test("createThrottledFetch: caps retries and returns the final 429", async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  console.warn = () => {};

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
  };

  try {
    const throttled = createThrottledFetch({ label: "Test", minIntervalMs: 0, maxRetries: 2 });
    const res = await throttled("https://example.test/x");

    assert.equal(res.status, 429);
    assert.equal(calls, 3, "initial attempt + 2 retries");
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});

test("createThrottledFetch: retries transport errors and rethrows when exhausted", async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  console.warn = () => {};

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) throw new Error("ECONNRESET");
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const throttled = createThrottledFetch({ label: "Test", minIntervalMs: 0, maxRetries: 3 });
    const res = await throttled("https://example.test/x");
    assert.equal(res.status, 200);
    assert.equal(calls, 3);

    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const failing = createThrottledFetch({ label: "Test", minIntervalMs: 0, maxRetries: 1 });
    await assert.rejects(() => failing("https://example.test/x"), /ECONNREFUSED/);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});