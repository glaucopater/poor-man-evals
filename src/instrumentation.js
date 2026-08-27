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

export const langfuseSpanProcessor = new LangfuseSpanProcessor({
  publicKey: requireEnv("LANGFUSE_PUBLIC_KEY"),
  secretKey: requireEnv("LANGFUSE_SECRET_KEY"),
  baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
  environment: process.env.NODE_ENV || "development",
});

const sdk = new NodeSDK({
  spanProcessors: [langfuseSpanProcessor],
});

sdk.start();
