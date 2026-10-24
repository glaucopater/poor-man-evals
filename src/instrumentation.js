// This module must be imported *before* anything else that creates spans
// (i.e. before the provider clients / judge run inside a trace). Importing it
// registers the Langfuse OpenTelemetry span processor(s) with the Node SDK.
import "dotenv/config";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

import { config, resolveLangfuseProjects } from "./config.js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

// Langfuse sources `environment` / `release` from env vars. The span processor
// reads them, and so does the LangfuseClient that writes scores -- so setting
// them here (before the client is constructed in runEval.js) keeps traces and
// their scores in ONE environment.
process.env.LANGFUSE_TRACING_ENVIRONMENT ??= process.env.NODE_ENV || "development";

const langfuseProjects = resolveLangfuseProjects(config, process.env);

export const langfuseSpanProcessors = langfuseProjects.map((project) =>
  new LangfuseSpanProcessor({
    publicKey: project.publicKey,
    secretKey: project.secretKey,
    baseUrl: project.baseUrl,
    environment: project.environment,
    release: project.release,
  })
);

// Backwards-compatible single-processor export.
export const langfuseSpanProcessor = langfuseSpanProcessors[0];

const sdk = new NodeSDK({
  spanProcessors: langfuseSpanProcessors,
});

sdk.start();

// Keep a reference so runEval can flush every processor.
export { sdk };
