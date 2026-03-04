import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { generateMessageStream } from "../providers/claude-provider.js";
import { CLAUDE_MODELS } from "../types.js";
import type {
  UniversalMessage,
  UniversalTool,
  ContentBlock,
} from "../types.js";
import type { Tool } from "../tools/types.js";
import { toUniversalTool } from "../tools/types.js";
import { truncateToolResult, countMessageTokens } from "./tokenCounter.js";
import { summarizeHistory } from "./summarizer.js";
import type { PermissionConfig, PermissionResult } from "./permissions.js";
import { getToolPermissionLevel } from "./permissions.js";
import {
  printToolCall,
  printToolResult,
  printToolError,
  printUnknownTool,
  printContextSummary,
  printTokenUsage,
  printStreamingText,
  printStreamingEnd,
  Spinner,
} from "../ui/format.js";

const DEFAULT_MAX_ITERATIONS = 50;
const CONTEXT_TOKEN_THRESHOLD = 80_000;
const KEEP_RECENT_MESSAGES = 6;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

export interface AgentConfig {
  client: BedrockRuntimeClient;
  systemPrompt: string;
  modelId?: string;
  maxIterations?: number;
  permissions?: PermissionConfig;
}

export class Agent {
  private client: BedrockRuntimeClient;
  private history: UniversalMessage[] = [];
  private tools = new Map<string, Tool>();
  private systemPrompt: string;
  private modelId: string;
  private maxIterations: number;
  private permissions: PermissionConfig | undefined;
  private spinner = new Spinner();

  constructor(config: AgentConfig) {
    this.client = config.client;
    this.systemPrompt = config.systemPrompt;
    this.modelId = config.modelId ?? CLAUDE_MODELS.CLAUDE_4_5_SONNET;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.permissions = config.permissions;
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getTools(): Map<string, Tool> {
    return this.tools;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getModelId(): string {
    return this.modelId;
  }

  getClient(): BedrockRuntimeClient {
    return this.client;
  }

  private getToolDefinitions(): UniversalTool[] {
    return Array.from(this.tools.values()).map(toUniversalTool);
  }

  private async maybeSummarize(): Promise<void> {
    const tokensBefore = countMessageTokens(this.history);
    if (
      tokensBefore < CONTEXT_TOKEN_THRESHOLD ||
      this.history.length <= KEEP_RECENT_MESSAGES
    ) {
      return;
    }

    this.spinner.start("Summarizing conversation history...");

    const toSummarize = this.history.slice(0, -KEEP_RECENT_MESSAGES);
    const toKeep = this.history.slice(-KEEP_RECENT_MESSAGES);

    const summary = await summarizeHistory(
      this.client,
      toSummarize,
      CLAUDE_MODELS.CLAUDE_3_5_HAIKU,
    );

    this.history = [
      { role: "user", content: `[Previous conversation summary]: ${summary}` },
      {
        role: "assistant",
        content:
          "Understood. I have the context from our previous conversation.",
      },
      ...toKeep,
    ];

    this.spinner.stop();
    const tokensAfter = countMessageTokens(this.history);
    printContextSummary(tokensBefore, tokensAfter);
  }

  /**
   * Calls the model with streaming and retry logic.
   * Returns the collected content blocks and estimated token counts.
   */
  private async callModelStreaming(): Promise<{
    content: ContentBlock[];
    stopReason: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const content: ContentBlock[] = [];
        let streamedText = "";
        let isStreamingText = false;
        let stopReason = "end_turn";
        let inputTokens = 0;
        let outputTokens = 0;

        const stream = generateMessageStream(
          this.client,
          this.history,
          this.modelId,
          {
            systemPrompt: this.systemPrompt,
            tools: this.getToolDefinitions(),
            temperature: 0.3,
          },
        );

        for await (const chunk of stream) {
          if (chunk.type === "text") {
            if (chunk.delta) {
              // First text chunk — stop spinner, start streaming output
              if (!isStreamingText) {
                this.spinner.stop();
                isStreamingText = true;
              }
              streamedText += chunk.delta;
              printStreamingText(chunk.delta);
            }
            if (chunk.finished) {
              if (isStreamingText && streamedText) {
                printStreamingEnd();
                content.push({ type: "text", text: streamedText });
                streamedText = "";
                isStreamingText = false;
              }
            }
          } else if (chunk.type === "tool_use") {
            // If we were streaming text, flush it
            if (isStreamingText && streamedText) {
              printStreamingEnd();
              content.push({ type: "text", text: streamedText });
              streamedText = "";
              isStreamingText = false;
            }
            this.spinner.stop();
            content.push({
              type: "tool_use",
              id: chunk.id,
              name: chunk.tool_name,
              input: chunk.tool_input,
            });
          } else if (chunk.type === "message_meta") {
            if (chunk.usage) {
              inputTokens = chunk.usage.input_tokens;
              outputTokens = chunk.usage.output_tokens;
            }
            if (chunk.stop_reason) {
              stopReason = chunk.stop_reason;
            }
          }
        }

        // Flush any remaining text
        if (streamedText) {
          if (isStreamingText) {
            printStreamingEnd();
          }
          content.push({ type: "text", text: streamedText });
        }

        return {
          content,
          stopReason,
          inputTokens,
          outputTokens,
        };
      } catch (error: unknown) {
        lastError = error;
        const isThrottling =
          error instanceof Error &&
          (error.name === "ThrottlingException" ||
            error.message.includes("ThrottlingException") ||
            error.message.includes("Too many requests") ||
            error.message.includes("rate limit"));

        if (isThrottling && attempt < MAX_RETRIES - 1) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          this.spinner.start(
            `Rate limited, retrying in ${(delay / 1000).toFixed(0)}s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          this.spinner.stop();
          continue;
        }

        // Non-throttling error or final attempt — rethrow
        throw error;
      }
    }

    throw lastError;
  }

  async run(userMessage: string): Promise<string> {
    await this.maybeSummarize();
    this.history.push({ role: "user", content: userMessage });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const thinkingMsg = iteration === 0 ? "Thinking..." : `Thinking... (step ${iteration + 1})`;
      this.spinner.start(thinkingMsg);

      let response: {
        content: ContentBlock[];
        stopReason: string;
        inputTokens: number;
        outputTokens: number;
      };

      try {
        response = await this.callModelStreaming();
      } catch (error: unknown) {
        this.spinner.stop();
        const message =
          error instanceof Error ? error.message : String(error);
        // Don't crash the REPL — return the error as a response
        printTokenUsage(totalInputTokens, totalOutputTokens);
        return `[Error calling model: ${message}]`;
      }

      this.spinner.stop();

      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;

      // Add the assistant's full response to history
      this.history.push({ role: "assistant", content: response.content });

      // Separate text and tool_use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
          b.type === "tool_use",
      );

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0) {
        printTokenUsage(totalInputTokens, totalOutputTokens);
        return response.content
          .filter(
            (b): b is Extract<ContentBlock, { type: "text" }> =>
              b.type === "text",
          )
          .map((b) => b.text)
          .join("");
      }

      // Execute each tool call and collect results
      const toolResults: ContentBlock[] = [];
      for (const toolUse of toolUseBlocks) {
        const tool = this.tools.get(toolUse.name);
        if (!tool) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: Unknown tool "${toolUse.name}"`,
            is_error: true,
          });
          printUnknownTool(toolUse.name);
          continue;
        }

        printToolCall(toolUse.name, toolUse.input);

        // Permission check
        if (this.permissions) {
          const level = getToolPermissionLevel(toolUse.name);
          if (!this.permissions.autoAllow.has(level)) {
            const result: PermissionResult = await this.permissions.promptUser(
              toolUse.name,
              toolUse.input,
            );
            if (result === "abort") {
              printTokenUsage(totalInputTokens, totalOutputTokens);
              return "[User aborted the current operation]";
            }
            if (result === "denied") {
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content:
                  "Permission denied by user. IMPORTANT: Do not retry this operation or attempt alternative tools to achieve the same goal. Stop and ask the user what they would like to do instead.",
                is_error: true,
              });
              // Push results collected so far and return immediately
              this.history.push({ role: "user", content: toolResults });
              printTokenUsage(totalInputTokens, totalOutputTokens);
              return "[Permission denied — waiting for new instructions]";
            }
          }
        }

        try {
          const result = await tool.execute(toolUse.input);
          const truncated = truncateToolResult(result);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: truncated,
          });
          printToolResult(toolUse.name, truncated, false);
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: ${message}`,
            is_error: true,
          });
          printToolError(toolUse.name, message);
        }
      }

      // Feed tool results back to the model
      this.history.push({ role: "user", content: toolResults });
    }

    printTokenUsage(totalInputTokens, totalOutputTokens);
    return "[Agent reached maximum tool iterations]";
  }

  clearHistory(): void {
    this.history = [];
  }
}
