import { z } from "zod";

// ── Message types ──────────────────────────────────────────────

export const MessageRoleSchema = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const UniversalMessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});
export type UniversalMessage = z.infer<typeof UniversalMessageSchema>;

// ── Tool definitions ───────────────────────────────────────────

export const UniversalToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
});
export type UniversalTool = z.infer<typeof UniversalToolSchema>;

// ── Response types ─────────────────────────────────────────────

export const UsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const UniversalResponseSchema = z.object({
  content: z.array(ContentBlockSchema),
  usage: UsageSchema,
  stop_reason: z.string(),
  model: z.string(),
});
export type UniversalResponse = z.infer<typeof UniversalResponseSchema>;

// ── Stream chunk types ─────────────────────────────────────────

export const TextStreamChunkSchema = z.object({
  type: z.literal("text"),
  delta: z.string().optional(),
  finished: z.boolean().optional(),
});

export const ToolUseStreamChunkSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
});

export const MessageMetaStreamChunkSchema = z.object({
  type: z.literal("message_meta"),
  usage: UsageSchema.optional(),
  stop_reason: z.string().optional(),
});

export const StreamChunkSchema = z.discriminatedUnion("type", [
  TextStreamChunkSchema,
  ToolUseStreamChunkSchema,
  MessageMetaStreamChunkSchema,
]);
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

// ── Bedrock configuration ──────────────────────────────────────

export const BedrockConfigSchema = z.object({
  region: z.string().default("us-east-1"),
  modelId: z
    .string()
    .default("us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
  maxTokens: z.number().default(4096),
  temperature: z.number().default(0.7),
  awsAccessKeyId: z.string().optional(),
  awsSecretAccessKey: z.string().optional(),
});
export type BedrockConfig = z.infer<typeof BedrockConfigSchema>;

// ── Claude model IDs ───────────────────────────────────────────

export const CLAUDE_MODELS = {
  CLAUDE_4_SONNET: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  CLAUDE_4_5_SONNET: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  CLAUDE_3_5_HAIKU: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
} as const;
