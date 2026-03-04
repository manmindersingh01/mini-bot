import { Command } from "commander";
import * as readline from "node:readline";
import chalk from "chalk";
import { createBedrockClient } from "./providers/bedrock-client.js";
import {
  generateMessage,
  generateMessageStream,
} from "./providers/claude-provider.js";
import { CLAUDE_MODELS } from "./types.js";
import type { UniversalMessage } from "./types.js";
import { Agent } from "./agent/engine.js";
import { buildSystemPrompt } from "./agent/promptBuilder.js";
import {
  createListFilesTool,
  createReadFileTool,
  createWriteFileTool,
} from "./tools/fileSystem.js";
import { createEditFileTool } from "./tools/editFile.js";
import { createAddImportTool } from "./tools/addImport.js";
import { createBashTool } from "./tools/bash.js";
import { createGrepTool } from "./tools/grep.js";
import { createReadRangeTool } from "./tools/readRange.js";
import { createLineEditTool } from "./tools/lineEditor.js";
import { createSaveMemoryTool, createRecallMemoryTool } from "./tools/memory.js";
import type {
  PermissionConfig,
  PermissionResult,
} from "./agent/permissions.js";
import {
  printWelcome,
  formatUserPrompt,
  printAssistantResponse,
  printPastedInput,
  printError,
  printConversationCleared,
  formatPermissionPrompt,
} from "./ui/format.js";

// ── Permission config ──────────────────────────────────────────
// Accepts the REPL's readline instance to avoid creating a competing one.
// Two readline interfaces on the same stdin will fight over input.

function createPermissionConfig(rl: readline.Interface): PermissionConfig {
  const sessionAllowed = new Set<string>();

  return {
    autoAllow: new Set(["read"] as const),
    async promptUser(toolName, input): Promise<PermissionResult> {
      if (sessionAllowed.has(toolName)) return "allowed";

      // Reuse the REPL's readline — do NOT create a new one
      const answer = await new Promise<string>((resolve) => {
        rl.question(formatPermissionPrompt(toolName, input), resolve);
      });

      const choice = answer.trim().toLowerCase();
      if (choice === "exit" || choice === "quit") {
        return "abort";
      }
      if (choice === "a") {
        sessionAllowed.add(toolName);
        return "allowed";
      }
      return choice === "y" ? "allowed" : "denied";
    },
  };
}

// ── Agent factory ──────────────────────────────────────────────

async function createAgent(
  opts: { model: string; region?: string; autoApprove?: boolean },
  rl: readline.Interface,
): Promise<Agent> {
  const client = createBedrockClient(
    opts.region ? { region: opts.region } : {},
  );
  const rootDir = process.cwd();

  const agent = new Agent({
    client,
    systemPrompt: "",
    modelId: opts.model,
    permissions: opts.autoApprove
      ? { autoAllow: new Set(["read", "write", "execute"] as const), promptUser: async () => "allowed" as const }
      : createPermissionConfig(rl),
  });

  // Register tools first so the dynamic prompt can list them
  agent.registerTool(createListFilesTool(rootDir));
  agent.registerTool(createReadFileTool(rootDir));
  agent.registerTool(createWriteFileTool(rootDir));
  agent.registerTool(createEditFileTool(rootDir));
  agent.registerTool(createAddImportTool(rootDir));
  agent.registerTool(createBashTool(rootDir));
  agent.registerTool(createGrepTool(rootDir));
  agent.registerTool(createReadRangeTool(rootDir));
  agent.registerTool(createLineEditTool(rootDir));
  agent.registerTool(createSaveMemoryTool(rootDir));
  agent.registerTool(createRecallMemoryTool(rootDir));

  // Build dynamic system prompt with environment info, CLAUDE.md, and tool listing
  const systemPrompt = await buildSystemPrompt({
    rootDir,
    tools: agent.getTools(),
  });
  agent.setSystemPrompt(systemPrompt);

  return agent;
}

// ── Interactive REPL ───────────────────────────────────────────

async function startAgentRepl(opts: {
  model: string;
  region?: string;
  autoApprove?: boolean;
}): Promise<void> {
  // Single readline instance — shared between REPL and permission prompts
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const agent = await createAgent(opts, rl);

  printWelcome(process.cwd(), opts.model);

  // ── Paste-aware input handling ──────────────────────────────
  //
  // Problem: readline fires "line" for every \n. Pasting multi-line
  // text sends many lines within milliseconds, auto-submitting.
  //
  // Solution: two-phase approach:
  //   1. Detect paste via timing (lines arriving < 50ms apart)
  //   2. For single lines → submit immediately (normal typing)
  //   3. For multi-line paste → buffer it, show preview box,
  //      then wait for the user to press Enter to actually submit.

  const PASTE_DEBOUNCE_MS = 100;
  let lineBuffer: string[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;
  let pendingPaste: string | null = null; // buffered paste awaiting Enter

  const showPrompt = (): void => {
    process.stdout.write(formatUserPrompt());
  };

  const clearEchoedLines = (count: number): void => {
    for (let i = 0; i < count; i++) {
      process.stdout.write("\x1b[1A\x1b[2K");
    }
  };

  const submitInput = async (fullInput: string): Promise<void> => {
    processing = true;

    const trimmed = fullInput.trim();
    if (!trimmed) {
      processing = false;
      showPrompt();
      return;
    }
    if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
      console.log(`\n  ${chalk.dim("Goodbye!")}\n`);
      rl.close();
      return;
    }
    if (trimmed.toLowerCase() === "/clear") {
      agent.clearHistory();
      printConversationCleared();
      processing = false;
      showPrompt();
      return;
    }

    try {
      const response = await agent.run(trimmed);
      // Text is already streamed to stdout by the engine.
      // Only print if response starts with "[" (error/status messages not streamed).
      if (response.startsWith("[")) {
        printAssistantResponse(response);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      printError(message);
    }

    processing = false;
    showPrompt();
  };

  rl.on("line", (line: string) => {
    // Ignore input while the agent is processing
    if (processing) return;

    // ── Phase 2: user pressed Enter after a paste preview ──
    // If we have a pending paste, the user is now confirming.
    // They may have typed extra text on this line to add context.
    if (pendingPaste !== null) {
      const extra = line.trim();
      const fullInput = extra
        ? `${extra}\n\n${pendingPaste}` // user's message + pasted context
        : pendingPaste; // just the paste
      pendingPaste = null;
      void submitInput(fullInput);
      return;
    }

    // ── Phase 1: collect lines, detect paste via debounce ──
    lineBuffer.push(line);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const lines = lineBuffer;
      const fullInput = lines.join("\n");
      lineBuffer = [];
      debounceTimer = null;

      if (lines.length === 1) {
        // Single line — normal typing, submit immediately
        void submitInput(fullInput);
      } else {
        // Multi-line paste detected — show preview, wait for Enter
        clearEchoedLines(lines.length);
        printPastedInput(fullInput.trim(), lines.length);
        pendingPaste = fullInput;
        console.log(
          `  ${chalk.dim("Press Enter to send, or type a message first:")}`,
        );
        showPrompt();
      }
    }, PASTE_DEBOUNCE_MS);
  });

  rl.on("close", () => {
    process.exit(0);
  });

  showPrompt();
}

// ── CLI program ────────────────────────────────────────────────

export function createProgram(): Command {
  const program = new Command();

  program
    .name("mini-claude")
    .description("CLI coding agent my mangoman")
    .version("0.1.0");

  // ── Default: interactive agent with tools ────────────────────

  program
    .option(
      "-m, --model <modelId>",
      "Bedrock model ID",
      CLAUDE_MODELS.CLAUDE_4_5_SONNET,
    )
    .option("--region <region>", "AWS region")
    .option("--auto-approve", "Skip all permission prompts (use with caution)")
    .action(async (opts: { model: string; region?: string; autoApprove?: boolean }) => {
      await startAgentRepl(opts);
    });

  // ── ask: one-shot prompt (no tools) ──────────────────────────

  program
    .command("ask")
    .description("Send a one-shot prompt to Claude (no tools)")
    .argument("<prompt>", "The prompt to send")
    .option(
      "-m, --model <modelId>",
      "Bedrock model ID",
      CLAUDE_MODELS.CLAUDE_4_5_SONNET,
    )
    .option("--region <region>", "AWS region")
    .option("--no-stream", "Disable streaming output")
    .action(
      async (
        promptText: string,
        opts: { model: string; region?: string; stream: boolean },
      ) => {
        const client = createBedrockClient(
          opts.region ? { region: opts.region } : {},
        );
        const messages: UniversalMessage[] = [
          { role: "user", content: promptText },
        ];

        if (opts.stream) {
          const stream = generateMessageStream(client, messages, opts.model);
          for await (const chunk of stream) {
            if (chunk.type === "text" && chunk.delta) {
              process.stdout.write(chunk.delta);
            }
            if (chunk.type === "text" && chunk.finished) {
              process.stdout.write("\n");
            }
          }
        } else {
          const response = await generateMessage(client, messages, opts.model);
          for (const block of response.content) {
            if (block.type === "text") {
              console.log(block.text);
            }
          }
        }
      },
    );

  return program;
}
