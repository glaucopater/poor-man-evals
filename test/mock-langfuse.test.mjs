import { test } from "node:test";
import assert from "node:assert/strict";

import { startMockLangfuse, summarizeTraffic } from "../scripts/mock-langfuse.mjs";

test("mock: accepts OTLP, ingestion and media, recording each", async () => {
  const mock = await startMockLangfuse();
  try {
    for (const path of [
      "/api/public/otel/v1/traces",
      "/api/public/ingestion",
      "/api/public/media?name=x",
    ]) {
      const res = await fetch(`${mock.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Basic abc" },
        body: JSON.stringify({ hello: "world" }),
      });
      assert.equal(res.status, 200, path);
    }

    assert.equal(mock.captured.length, 3);
    assert.deepEqual(
      mock.captured.map((c) => c.path),
      ["/api/public/otel/v1/traces", "/api/public/ingestion", "/api/public/media"]
    );
    assert.equal(mock.captured[0].headers.authorization, "Basic abc", "headers are captured for auth assertions");
    assert.ok(mock.captured[0].body.length > 0, "body is captured for payload assertions");
  } finally {
    await mock.close();
  }
});

test("mock: listens on loopback with an ephemeral port", async () => {
  const mock = await startMockLangfuse();
  try {
    assert.match(mock.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await mock.close();
  }
});

test("mock: close() is idempotent enough to be called in a finally block", async () => {
  const mock = await startMockLangfuse();
  await mock.close();
  // A second close must not throw, since callers use it from cleanup paths.
  await mock.close();
});

test("summarizeTraffic: groups captured requests by kind", () => {
  const bytes = (n) => Buffer.alloc(n);
  const rows = summarizeTraffic([
    { path: "/api/public/otel/v1/traces", body: bytes(100) },
    { path: "/api/public/otel/v1/traces", body: bytes(50) },
    { path: "/api/public/ingestion", body: bytes(20) },
    { path: "/api/public/media", body: bytes(5) },
  ]);

  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
  assert.equal(byKind["spans (OTLP)"].requests, 2);
  assert.equal(byKind["spans (OTLP)"].bytes, 150);
  assert.equal(byKind["score writes"].requests, 1);
  assert.equal(byKind["media uploads"].requests, 1);
});

test("summarizeTraffic: a dry run that produced nothing reports nothing", () => {
  // The dry runner's whole value is "nothing was ingested", so an empty capture
  // must be visible rather than silently reported as a clean run.
  assert.deepEqual(summarizeTraffic([]), []);
});

test("summarizeTraffic: an unrecognised path is surfaced, not dropped", () => {
  const rows = summarizeTraffic([{ path: "/api/public/something-new", body: Buffer.alloc(7) }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "/api/public/something-new");
});