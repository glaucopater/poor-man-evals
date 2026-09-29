// This module must be imported *before* anything else that creates spans
// (i.e. before groqClient/judge run inside a trace). Importing it registers
// the Langfuse OpenTelemetry span processor with the Node SDK.
import "dotenv/config";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

// Langfuse v5 sources `environment` / `release` from env vars. The span
// processor reads them, and so does the LangfuseClient that writes scores --
// so setting them here (before the client is constructed in runEval.js) keeps
// traces and their scores in ONE environment. Previously the processor used
// NODE_ENV while the score writer fell back to "default", splitting them.
process.env.LANGFUSE_TRACING_ENVIRONMENT ??= process.env.NODE_ENV || "development";

export const langfuseSpanProcessor = new LangfuseSpanProcessor({
  publicKey: requireEnv("LANGFUSE_PUBLIC_KEY"),
  secretKey: requireEnv("LANGFUSE_SECRET_KEY"),
  baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
  // v5 exports spans created by Langfuse by default (plus gen_ai.*/known LLM
  // scopes). Every span this harness creates comes from the Langfuse SDK, so
  // the default filter keeps the whole trace tree. Set
  // `shouldExportSpan: () => true` here to export every OTel span instead.
});

const sdk = new NodeSDK({
  spanProcessors: [langfuseSpanProcessor],
});

sdk.start();
