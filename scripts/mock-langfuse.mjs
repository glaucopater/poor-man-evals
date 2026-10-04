/**
 * A throwaway stand-in for a Langfuse server.
 *
 * Listens on an ephemeral loopback port and accepts everything, recording what
 * was sent. Used by two callers:
 *   - verify-langfuse-v5.mjs, which asserts on the recorded traffic
 *   - eval-dry.mjs, which points a real eval run at it so the run exercises the
 *     genuine providers while nothing is ingested into a real project
 *
 * Kept in one place so the dry runner and the verifier cannot drift apart in
 * what counts as "a request we care about".
 */

import { createServer } from "node:http";

/**
 * Starts the mock on 127.0.0.1 with an OS-assigned port.
 *
 * @returns {Promise<{baseUrl: string, captured: Array<{path: string, headers: object, body: Buffer}>, close: () => Promise<void>}>}
 */
export async function startMockLangfuse() {
  const captured = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured.push({
        path: req.url.split("?")[0],
        headers: req.headers,
        body: Buffer.concat(chunks),
      });

      if (req.url.includes("/otel/")) {
        // The OTLP exporter posts protobuf and only checks for a 2xx.
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        res.end(Buffer.alloc(0));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ successes: [], errors: [] }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    captured,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Summarizes captured traffic by endpoint, for the dry runner's closing report.
 *
 * @param {Array<{path: string, body: Buffer}>} captured
 */
export function summarizeTraffic(captured) {
  const groups = new Map();
  for (const entry of captured) {
    const kind = entry.path.includes("/otel/")
      ? "spans (OTLP)"
      : entry.path.includes("/ingestion")
        ? "score writes"
        : entry.path.includes("/media")
          ? "media uploads"
          : entry.path;
    const g = groups.get(kind) ?? { requests: 0, bytes: 0 };
    g.requests += 1;
    g.bytes += entry.body.length;
    groups.set(kind, g);
  }
  return [...groups.entries()].map(([kind, g]) => ({ kind, ...g }));
}