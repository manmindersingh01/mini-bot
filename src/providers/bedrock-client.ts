import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ConfiguredRetryStrategy } from "@smithy/util-retry";
import type { BedrockConfig } from "../types.js";

const MAX_RETRY_ATTEMPTS = 12;

export function createBedrockClient(config: Partial<BedrockConfig> = {}): BedrockRuntimeClient {
  const region =
    config.region ??
    process.env["AWS_REGION"] ??
    process.env["AWS_DEFAULT_REGION"] ??
    "us-east-1";

  const credentials =
    config.awsAccessKeyId && config.awsSecretAccessKey
      ? {
          accessKeyId: config.awsAccessKeyId,
          secretAccessKey: config.awsSecretAccessKey,
        }
      : undefined;

  return new BedrockRuntimeClient({
    region,
    ...(credentials ? { credentials } : {}),
    retryStrategy: new ConfiguredRetryStrategy(
      MAX_RETRY_ATTEMPTS,
      (attempt: number) => 1000 * Math.pow(2, attempt),
    ),
  });
}
