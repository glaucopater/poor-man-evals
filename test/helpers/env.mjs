/**
 * Test bootstrap: sets the env the provider clients read at import time.
 *
 * This MUST be imported before anything that pulls in the provider clients,
 * because those modules read their throttle intervals at module-evaluation time
 * (ESM evaluates side-effect imports in declaration order, so
 * `import "./helpers/env.mjs"` first does the job). The API key presence check
 * runs per call, so the dummy value here is never sent anywhere -- every test
 * stubs `globalThis.fetch`.
 */
process.env.GROQ_API_KEY ??= "test-key-not-used";
process.env.NVIDIA_API_KEY ??= "test-key-not-used";

// No artificial delay between stubbed calls.
process.env.GROQ_MIN_REQUEST_INTERVAL_MS ??= "0";
process.env.NVIDIA_MIN_REQUEST_INTERVAL_MS ??= "0";

// Silence the throttle's retry warnings unless a test overrides console.warn.
const realWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("(429)")) return;
  realWarn(...args);
};