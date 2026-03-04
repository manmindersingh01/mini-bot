# mini-claude-code — Architecture & Implementation Guide

A CLI coding assistant built with TypeScript that uses Claude via AWS Bedrock. This document explains every layer of the system, the strategies behind each design decision, and how data flows through the tool.

---

## Table of Contents

- [How It Works (High Level)](#how-it-works-high-level)
- [The Agentic Loop](#the-agentic-loop)
- [Project Structure](#project-structure)
- [Layer 1: CLI & REPL](#layer-1-cli--repl)
- [Layer 2: Agent Engine](#layer-2-agent-engine)
- [Layer 3: Provider (Bedrock)](#layer-3-provider-bedrock)
- [Layer 4: Tools](#layer-4-tools)
- [Strategy: Context Management](#strategy-context-management)
- [Strategy: Permission System](#strategy-permission-system)
- [Strategy: Dynamic System Prompt](#strategy-dynamic-system-prompt)
- [Strategy: Terminal UI](#strategy-terminal-ui)
- [Data Flow Walkthrough](#data-flow-walkthrough)
- [Key Design Decisions](#key-design-decisions)

---

## How It Works (High Level)

The tool is an **agentic loop** — a pattern where an LLM is called repeatedly, with access to tools, until it decides it has enough information to respond. The host application (this CLI) orchestrates the loop:

```
User types a message
    → CLI sends it to Claude (with tool definitions)
    → Claude responds with either:
        a) A text response (done — show it to user)
        b) One or more tool calls (execute them, feed results back, repeat)
```

Claude is stateless — it has no memory between API calls. The **entire conversation history** (every message, every tool call, every result) is sent on every request. This conversation array IS the context.

---

## The Agentic Loop

This is the core pattern. Everything else is built around it.

```
┌──────────────────────────────────────────────────┐
│                  Agent Loop                       │
│                                                   │
│  1. Add user message to history                   │
│  2. Call Claude API with:                         │
│     - system prompt                               │
│     - full conversation history                   │
│     - tool definitions (JSON schemas)             │
│  3. Claude responds with content blocks:          │
│     - text blocks → display to user               │
│     - tool_use blocks → execute tools             │
│  4. If tool_use blocks found:                     │
│     a. Execute each tool                          │
│     b. Collect tool_result blocks                 │
│     c. Add results to history                     │
│     d. Go to step 2                               │
│  5. If no tool calls → return text, loop ends     │
│                                                   │
│  Safety: max 20 iterations to prevent runaway     │
└──────────────────────────────────────────────────┘
```

**File:** `src/agent/engine.ts` — the `Agent.run()` method

---

## Project Structure

```
src/
├── index.ts                    # Entry point — creates CLI, parses args
├── cli.ts                      # Commander CLI, REPL loop, tool registration
├── types.ts                    # Zod schemas for messages, tools, responses
│
├── agent/
│   ├── engine.ts               # Core agent loop (Agent class)
│   ├── permissions.ts          # Permission levels for tools
│   ├── promptBuilder.ts        # Dynamic system prompt construction
│   ├── prompt.ts               # Base prompt text (legacy, unused)
│   ├── tokenCounter.ts         # tiktoken-based token counting + truncation
│   └── summarizer.ts           # Conversation history compression
│
├── providers/
│   ├── bedrock-client.ts       # AWS Bedrock client factory
│   └── claude-provider.ts      # API call abstraction (streaming + non-streaming)
│
├── tools/
│   ├── types.ts                # Tool interface definition
│   ├── pathUtils.ts            # Path traversal security guard
│   ├── fileSystem.ts           # list_files, read_file, write_file
│   ├── editFile.ts             # edit_file (exact string replacement + diff)
│   ├── bash.ts                 # bash (shell command execution)
│   └── grep.ts                 # grep (ripgrep text search)
│
└── ui/
    └── format.ts               # Terminal formatting, colors, custom markdown renderer, diffs
```

**~1,550 lines** of TypeScript across 18 files.

---

## Layer 1: CLI & REPL

**File:** `src/cli.ts` (184 lines)

The CLI has two modes:

### Interactive Mode (default)

```bash
npm run dev
```

Starts a REPL (Read-Eval-Print Loop) powered by Node's `readline`:

1. A **single readline interface** is created — shared between the REPL prompt and permission prompts (two readline interfaces on the same `stdin` will fight over input — this was a real bug we fixed).
2. The Agent is created with all 6 tools registered.
3. The dynamic system prompt is built (reads environment, CLAUDE.md, lists tools).
4. User input goes to `agent.run()`, response is rendered as markdown.

### One-Shot Mode

```bash
npm run dev -- ask "What is TypeScript?"
```

Sends a single prompt to Claude with no tools, optionally with streaming output.

### Tool Registration

All tools follow the factory pattern — `createXxxTool(rootDir)` returns a `Tool` object. They're registered in order:

```typescript
agent.registerTool(createListFilesTool(rootDir));
agent.registerTool(createReadFileTool(rootDir));
agent.registerTool(createWriteFileTool(rootDir));
agent.registerTool(createEditFileTool(rootDir));
agent.registerTool(createBashTool(rootDir));
agent.registerTool(createGrepTool(rootDir));
```

---

## Layer 2: Agent Engine

**File:** `src/agent/engine.ts` (198 lines)

The `Agent` class is the brain of the system.

### State

```typescript
class Agent {
  private client: BedrockRuntimeClient;     // API client
  private history: UniversalMessage[] = [];  // Full conversation
  private tools = new Map<string, Tool>();   // Registered tools
  private systemPrompt: string;              // Dynamic prompt
  private modelId: string;                   // Which Claude model
  private maxIterations: number;             // Safety limit (20)
  private permissions?: PermissionConfig;    // Permission checker
  private spinner = new Spinner();           // Loading indicator
}
```

### The Run Loop

```typescript
async run(userMessage: string): Promise<string> {
  // 1. Check if context needs summarization
  await this.maybeSummarize();

  // 2. Add user message to history
  this.history.push({ role: "user", content: userMessage });

  // 3. Loop: call Claude, execute tools, repeat
  for (let i = 0; i < this.maxIterations; i++) {
    const response = await generateMessage(this.client, this.history, ...);

    // Log token usage after every API call
    printTokenUsage(response.usage.input_tokens, response.usage.output_tokens);

    this.history.push({ role: "assistant", content: response.content });

    const toolCalls = response.content.filter(b => b.type === "tool_use");

    // No tools? We're done.
    if (toolCalls.length === 0 || response.stop_reason === "end_turn") {
      return extractText(response);
    }

    // Execute each tool
    for (const toolCall of toolCalls) {
      // Check permission → execute → truncate result → collect
    }

    // Feed results back as a user message (Claude API convention)
    this.history.push({ role: "user", content: toolResults });
  }
}
```

### Important detail: tool results are "user" messages

The Claude API requires alternating user/assistant messages. Tool results go in as `role: "user"` messages containing `tool_result` content blocks. The LLM sees: user → assistant (with tool calls) → user (with tool results) → assistant → ...

---

## Layer 3: Provider (Bedrock)

### Client Factory

**File:** `src/providers/bedrock-client.ts` (31 lines)

Creates the AWS Bedrock client with:
- Region from config, `AWS_REGION`, `AWS_DEFAULT_REGION`, or `"us-east-1"`
- Exponential backoff retry: max 12 attempts, starting at 1000ms
- Optional explicit AWS credentials

### API Wrapper

**File:** `src/providers/claude-provider.ts` (208 lines)

Abstracts Bedrock's raw API into a clean interface.

**`generateMessage()`** — Non-streaming call:
1. Converts `UniversalMessage[]` to Claude's API format
2. Adds system prompt, tools, temperature, max_tokens
3. Calls `InvokeModelCommand`
4. Parses response into `UniversalResponse` with content blocks and usage stats

**`generateMessageStream()`** — Streaming async generator:
1. Same request setup
2. Calls `InvokeModelWithResponseStreamCommand`
3. Yields `StreamChunk` objects as events arrive
4. Accumulates tool input JSON across multiple `input_json_delta` events
5. Parses complete tool input on `content_block_stop`

**Why two call modes?** The interactive REPL uses non-streaming (tools need the full response before executing). The `ask` command uses streaming for real-time output.

---

## Layer 4: Tools

All tools implement the `Tool` interface:

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema for Claude
  execute(input: Record<string, unknown>): Promise<string>;
}
```

The `inputSchema` is a JSON Schema that Claude uses to understand what arguments the tool accepts. Claude generates the arguments; the host validates and executes.

### Security: Path Safety

**File:** `src/tools/pathUtils.ts`

Every tool that touches the filesystem calls `resolveSafe(rootDir, userPath)`:

```typescript
function resolveSafe(rootDir: string, userPath: string): string {
  const resolved = path.resolve(rootDir, userPath);
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    throw new Error(`Path "${userPath}" is outside the project directory.`);
  }
  return resolved;
}
```

This prevents path traversal attacks like `../../etc/passwd`. The LLM generates paths — you can't trust them.

### Tool: `list_files`

Uses `glob` to find files matching a pattern. Ignores `node_modules`, `.git`, `dist`. Returns sorted relative paths.

### Tool: `read_file`

Reads a file and returns its content as a string. Simple but critical — the agent reads files before modifying them.

### Tool: `write_file`

Creates or overwrites a file. Automatically creates parent directories with `fs.mkdir(recursive: true)`.

### Tool: `edit_file`

The most important tool. Uses **exact string replacement** instead of line numbers.

```typescript
// Count occurrences — must be exactly 1
const occurrences = content.split(oldString).length - 1;

if (occurrences === 0) throw new Error("not found");
if (occurrences > 1) throw new Error("ambiguous");

const newContent = content.replace(oldString, newString);
```

**Why string matching over line numbers?**
- Line numbers shift when you edit a file. If you edit line 10, everything after moves.
- The LLM already saw the file content, so it knows the exact text.
- It's idempotent — the same edit applied twice fails cleanly ("not found" on second attempt).
- It handles multi-line edits naturally.

After the edit, a **colorized unified diff** is printed to the terminal using the `diff` library.

### Tool: `bash`

Executes shell commands via `child_process.execFile("/bin/bash", ["-c", command])`.

Key design choices:
- **Callback-based Promise** (not `promisify`) — to capture stdout/stderr even on non-zero exit codes
- **Never throws** — always returns output so the agent can see errors and react
- **Timeout** — default 30s, max 120s, enforced minimum 1s
- **Truncation** — stdout and stderr independently capped at 50K chars
- **Max buffer** — 1MB to prevent memory issues

### Tool: `grep`

Wraps `@vscode/ripgrep` for fast code search.

**CJS import workaround:** `@vscode/ripgrep` is a CommonJS module, but this project uses `verbatimModuleSyntax` (ESM only). The solution:

```typescript
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };
```

The package only exports `rgPath` — the path to the ripgrep binary. We call it via `execFile`.

Features: regex/literal patterns, glob filtering, context lines (0–10), auto-excludes node_modules/.git/dist, truncates at 100K chars. Handles ripgrep's exit code 1 (no matches) as a normal result, not an error.

---

## Strategy: Context Management

**Files:** `src/agent/tokenCounter.ts`, `src/agent/summarizer.ts`

The conversation history grows with every turn. Eventually it would exceed Claude's context window. Three mechanisms handle this:

### 1. Token Counting (tiktoken)

```typescript
import { get_encoding } from "tiktoken";
const encoder = get_encoding("cl100k_base");

function countTokens(text: string): number {
  return encoder.encode(text).length;
}
```

`cl100k_base` is the closest publicly available encoding to Claude's tokenizer. Not exact, but far more accurate than the character-based heuristic (`length / 4`) that many projects use.

Token counts are displayed after every API call so you can see context growing.

### 2. Tool Result Truncation

Large file reads or command outputs can blow up context. Every tool result is passed through middle-truncation:

```typescript
function truncateToolResult(result: string, maxChars = 100_000): string {
  if (result.length <= maxChars) return result;
  const half = Math.floor(maxChars / 2);
  return result.slice(0, half) + "\n\n... [truncated] ...\n\n" + result.slice(-half);
}
```

**Why middle-truncation?** File headers (imports, class declarations) and file endings (exports, closing braces) are often the most informative parts. The middle is usually the body — less critical for understanding structure.

### 3. Conversation Summarization

When estimated tokens exceed **80,000**, the agent automatically summarizes older messages:

```typescript
async maybeSummarize(): Promise<void> {
  const tokens = countMessageTokens(this.history);
  if (tokens < 80_000) return;

  // Keep the 6 most recent messages untouched
  const toSummarize = this.history.slice(0, -6);
  const toKeep = this.history.slice(-6);

  // Use Haiku (fast, cheap) to summarize
  const summary = await summarizeHistory(client, toSummarize, CLAUDE_3_5_HAIKU);

  // Replace old messages with summary
  this.history = [
    { role: "user", content: `[Previous conversation summary]: ${summary}` },
    { role: "assistant", content: "Understood." },
    ...toKeep,
  ];
}
```

The summarization prompt focuses on preserving: **(1)** files discussed/modified, **(2)** key decisions made, **(3)** current task state. Uses Haiku (cheapest/fastest model) since this is an internal operation.

---

## Strategy: Permission System

**File:** `src/agent/permissions.ts`

Tools are categorized by risk level:

| Level | Tools | Behavior |
|-------|-------|----------|
| `read` | list_files, read_file, grep | Auto-allowed |
| `write` | write_file, edit_file | Prompts user |
| `execute` | bash | Prompts user |

Before executing any tool, the engine checks:

```typescript
if (this.permissions) {
  const level = getToolPermissionLevel(toolUse.name);
  if (!this.permissions.autoAllow.has(level)) {
    const allowed = await this.permissions.promptUser(toolName, input);
    if (!allowed) {
      // Feed "Permission denied" back to Claude as a tool_result
      toolResults.push({ content: "Permission denied by user.", is_error: true });
      continue;
    }
  }
}
```

The user can respond:
- `y` — allow this one time
- `n` — deny (Claude sees the denial and can adjust)
- `a` — allow this tool for the rest of the session

### Readline Sharing

The permission prompt reuses the REPL's `readline.Interface` instance. Creating a second readline on `stdin` causes them to compete for input — a bug we found and fixed. The solution: pass the REPL's `rl` into `createPermissionConfig(rl)`.

---

## Strategy: Dynamic System Prompt

**File:** `src/agent/promptBuilder.ts`

The system prompt is rebuilt on every agent creation with runtime information:

```
┌──────────────────────────────────────────────┐
│  System Prompt                                │
│                                               │
│  1. Base instructions                         │
│     - Workflow (list files → read → edit)     │
│     - Rules (stay in project dir, etc.)       │
│                                               │
│  2. Environment                               │
│     - Working directory                       │
│     - Platform (darwin/linux/win32)            │
│     - Node.js version                         │
│     - Date                                    │
│     - Git status (if in a repo)               │
│                                               │
│  3. Project instructions                      │
│     - Contents of CLAUDE.md (if present)      │
│                                               │
│  4. Available tools                           │
│     - Name + description for each tool        │
└──────────────────────────────────────────────┘
```

The CLAUDE.md feature lets projects provide custom instructions — coding conventions, tech stack details, testing procedures — that Claude follows.

---

## Strategy: Terminal UI

**File:** `src/ui/format.ts` (195 lines)

All terminal output is centralized in this module. Nothing in the codebase calls `console.log` with raw text for user-facing output.

### Color Theme

```
primary   = #D97706 (amber)    — brand accent, prompt arrow, spinner
secondary = #8B5CF6 (violet)   — diff hunks, section markers
success   = green               — diff additions
error     = red                 — diff deletions, errors
warning   = yellow              — permission prompts
tool      = cyan                — tool names and invocations
dim/muted = gray                — metadata, secondary info
```

### Markdown Rendering

Assistant responses are rendered using a **custom markdown renderer** built with chalk — no external markdown libraries. The `renderMarkdown()` function processes text line-by-line, handling block-level elements (code blocks, headers, lists, blockquotes, horizontal rules), while `renderInline()` handles inline formatting (bold, italic, code, links, strikethrough).

| Markdown | Terminal rendering |
|---|---|
| `# Header` | Bold cyan underline |
| `## Header` | Bold cyan |
| `**bold**` | Bold white |
| `*italic*` | Italic bright blue |
| `` `code` `` | Yellow on gray background |
| ` ```lang ``` ` | Boxed with `┌│└` borders, yellow code |
| `- item` | Cyan `●` / `○` / `■` bullets (by depth) |
| `1. item` | Cyan numbered |
| `> quote` | Gray italic with dim `│` border |
| `[text](url)` | Cyan text + underlined URL |
| `~~strike~~` | Dim strikethrough |
| `---` | Dim horizontal line |

This approach replaced an earlier setup using `marked` + `marked-terminal`, which had compatibility issues across versions and produced inconsistent list/bold rendering in terminals.

### Diff Display

File edits produce a colorized unified diff:
- `+` lines in green (additions)
- `-` lines in red (deletions)
- `@@` hunks in violet
- Context lines dimmed

### Spinner

A braille-character spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) animates at 80ms intervals during API calls. Uses `\r` to overwrite the current line and clears with spaces when done.

---

## Data Flow Walkthrough

Here's what happens when you type `"add a TODO comment to index.ts"`:

```
1. REPL captures input via readline
   └→ cli.ts: rl.question() callback fires

2. agent.run("add a TODO comment to index.ts")
   └→ engine.ts: checks if summarization needed (no, first turn)
   └→ pushes { role: "user", content: "add a TODO..." } to history

3. First API call
   └→ spinner starts ("Thinking...")
   └→ generateMessage(client, history, modelId, { systemPrompt, tools })
   └→ claude-provider.ts: builds request body, calls InvokeModelCommand
   └→ Bedrock returns response with tool_use blocks
   └→ spinner stops
   └→ prints token usage: "tokens 1,234 in / 89 out / 1,323 total"

4. Claude wants to read the file first:
   └→ response.content = [
        { type: "text", text: "Let me read the file first." },
        { type: "tool_use", name: "read_file", input: { path: "src/index.ts" } }
      ]
   └→ prints: "> read_file path=src/index.ts"
   └→ permission check: "read" level → auto-allowed
   └→ executes tool → returns file content
   └→ truncates result (if > 100K chars)
   └→ pushes tool_result to history

5. Second API call (with file content in context)
   └→ Claude now has the file content
   └→ response.content = [
        { type: "text", text: "I'll add a TODO comment." },
        { type: "tool_use", name: "edit_file", input: { path: "...", old_string: "...", new_string: "..." } }
      ]
   └→ prints: "> edit_file path=src/index.ts +2 more"
   └→ permission check: "write" level → prompts user
   └→ user types "y"
   └→ executes edit: finds exact match, replaces, writes file
   └→ prints colorized diff to terminal
   └→ pushes tool_result to history

6. Third API call (confirming the edit)
   └→ Claude sees the edit succeeded
   └→ response.content = [{ type: "text", text: "Done! I added..." }]
   └→ No tool calls → loop ends
   └→ returns text

7. Response displayed
   └→ cli.ts: printAssistantResponse(text)
   └→ format.ts: markdown rendered with custom chalk renderer
   └→ REPL prompts for next input
```

---

## Key Design Decisions

### 1. Exact string matching for edits (not line numbers)
Line numbers shift when you edit. String matching is idempotent and naturally handles multi-line edits. If the string appears more than once, the tool errors — forcing the LLM to provide more context.

### 2. Tools never throw on operational errors
The bash tool returns exit code + stderr instead of throwing. The agent needs to see errors to react intelligently. Throwing would skip the tool result and confuse the LLM.

### 3. Single readline instance
Two readline interfaces on the same stdin will fight over input. The REPL's readline is shared with the permission system via parameter passing.

### 4. Middle-truncation for tool results
Keeps the beginning and end of large outputs, which tend to be the most informative (imports, exports, headers, final output).

### 5. Summarization with a cheap model
Context compression uses Haiku (fast, cheap) instead of the main model. The summary is internal infrastructure — it doesn't need the main model's capability.

### 6. All UI through one module
`format.ts` is the single source of truth for terminal output. This makes it trivial to change the look of the entire tool — adjust the theme object, and everything updates.

### 7. CJS import workaround for ripgrep
`@vscode/ripgrep` is CommonJS-only. In an ESM project with `verbatimModuleSyntax`, the solution is `createRequire(import.meta.url)` — a well-established pattern for bridging CJS modules into ESM.

### 8. Zod for type definitions
Message types are defined with Zod schemas, giving both TypeScript types (via `z.infer`) and runtime validation in one place. This matters because API responses are `unknown` — Zod validates them at the boundary.

---

## Dependencies

| Library | Role |
|---------|------|
| `commander` | CLI framework (commands, options, argument parsing) |
| `@aws-sdk/client-bedrock-runtime` | Bedrock API client |
| `@vscode/ripgrep` | Fast text search (grep tool) |
| `glob` | File pattern matching (list_files tool) |
| `chalk` | Terminal colors + custom markdown rendering |
| `diff` | Unified diff generation (edit_file display) |
| `tiktoken` | Accurate token counting (cl100k_base encoding) |
| `zod` | Runtime type validation |
| `ts-morph` | TypeScript AST manipulation (installed, not yet used) |
| `@ast-grep/napi` | Structural code search (installed, not yet used) |
