import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  ThrottlingException,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  UniversalMessage,
  UniversalResponse,
  UniversalTool,
  StreamChunk,
  ContentBlock,
} from "../types.js";
import { CLAUDE_MODELS } from "../types.js";

const ANTHROPIC_VERSION = "bedrock-2023-05-31";

interface GenerateOptions {
  systemPrompt?: string;
  tools?: UniversalTool[];
  maxTokens?: number;
  temperature?: number;
}

// ── Message format conversion ──────────────────────────────────

function convertContentToClaude(content: string | ContentBlock[]): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_use":
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
        };
    }
  });
}

function buildRequestBody(
  messages: UniversalMessage[],
  options: GenerateOptions,
): Record<string, unknown> {
  const claudeMessages = messages.map((msg) => ({
    role: msg.role,
    content: convertContentToClaude(msg.content),
  }));

  const body: Record<string, unknown> = {
    anthropic_version: ANTHROPIC_VERSION,
    max_tokens: options.maxTokens ?? 16_384,
    temperature: options.temperature ?? 0.7,
    messages: claudeMessages,
  };

  if (options.systemPrompt) {
    body["system"] = options.systemPrompt;
  }

  const claudeTools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
  if (claudeTools && claudeTools.length > 0) {
    body["tools"] = claudeTools;
  }

  return body;
}

// ── Non-streaming call ─────────────────────────────────────────

export async function generateMessage(
  client: BedrockRuntimeClient,
  messages: UniversalMessage[],
  modelId: string = CLAUDE_MODELS.CLAUDE_4_5_SONNET,
  options: GenerateOptions = {},
): Promise<UniversalResponse> {
  const body = buildRequestBody(messages, options);

  const command = new InvokeModelCommand({
    modelId,
    body: JSON.stringify(body),
  });

  const response = await client.send(command);
  const decoded = JSON.parse(new TextDecoder().decode(response.body));

  const content: ContentBlock[] = (decoded.content as unknown[]).map((item: any) => {
    if (item.type === "tool_use") {
      return { type: "tool_use" as const, id: item.id, name: item.name, input: item.input };
    }
    return { type: "text" as const, text: item.text ?? "" };
  });

  return {
    content,
    usage: {
      input_tokens: decoded.usage?.input_tokens ?? 0,
      output_tokens: decoded.usage?.output_tokens ?? 0,
    },
    stop_reason: decoded.stop_reason ?? "end_turn",
    model: modelId,
  };
}

// ── Streaming call ─────────────────────────────────────────────

export async function* generateMessageStream(
  client: BedrockRuntimeClient,
  messages: UniversalMessage[],
  modelId: string = CLAUDE_MODELS.CLAUDE_4_5_SONNET,
  options: GenerateOptions = {},
): AsyncGenerator<StreamChunk> {
  const body = buildRequestBody(messages, options);

  const command = new InvokeModelWithResponseStreamCommand({
    modelId,
    body: JSON.stringify(body),
  });

  const response = await client.send(command);

  let currentToolUse: { id: string; name: string; input: string } | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | undefined;

  if (response.body) {
    for await (const event of response.body) {
      if (!event.chunk?.bytes) continue;

      const data = JSON.parse(new TextDecoder().decode(event.chunk.bytes));

      // Message start — contains input token count
      if (data.type === "message_start" && data.message?.usage) {
        inputTokens = data.message.usage.input_tokens ?? 0;
      }
      // Text delta
      else if (data.type === "content_block_delta" && data.delta?.text) {
        yield { type: "text", delta: data.delta.text };
      }
      // Tool use start
      else if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
        currentToolUse = {
          id: data.content_block.id,
          name: data.content_block.name,
          input: "",
        };
      }
      // Tool input JSON delta
      else if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
        if (currentToolUse) {
          currentToolUse.input += data.delta.partial_json;
        }
      }
      // Tool use end — parse accumulated JSON and yield
      else if (data.type === "content_block_stop" && currentToolUse) {
        let parsedInput: Record<string, unknown>;
        try {
          parsedInput = JSON.parse(currentToolUse.input) as Record<string, unknown>;
        } catch {
          parsedInput = { _raw: currentToolUse.input, _parseError: true };
        }

        yield {
          type: "tool_use",
          id: currentToolUse.id,
          tool_name: currentToolUse.name,
          tool_input: parsedInput,
        };
        currentToolUse = null;
      }
      // Message delta — contains output token count and stop_reason
      else if (data.type === "message_delta") {
        if (data.usage?.output_tokens) {
          outputTokens = data.usage.output_tokens;
        }
        if (data.delta?.stop_reason) {
          stopReason = data.delta.stop_reason;
        }
      }
      // Message stop
      else if (data.type === "message_stop") {
        yield { type: "text", finished: true };
      }
    }
  }

  // Emit final metadata chunk with usage and stop reason
  yield {
    type: "message_meta",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    stop_reason: stopReason,
  };
}

// ── Connection test ────────────────────────────────────────────

export async function testConnection(
  client: BedrockRuntimeClient,
  modelId: string = CLAUDE_MODELS.CLAUDE_4_5_SONNET,
): Promise<{ success: boolean; model: string; error?: string }> {
  try {
    const response = await generateMessage(
      client,
      [{ role: "user", content: "Hi" }],
      modelId,
      { maxTokens: 10 },
    );
    return { success: true, model: response.model };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, model: modelId, error: message };
  }
}

export function isThrottlingError(error: unknown): boolean {
  return error instanceof ThrottlingException;
}
