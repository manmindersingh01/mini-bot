# mini-claude-code

A small CLI coding agent. You type, Claude reads and edits files in your repo, runs shell, and loops until the task is done. About 3k lines of TypeScript with no agent framework underneath.

## What it does

It's a REPL. You describe a change, the agent works through it with tool calls.

```
$ npm run dev
> add a 300ms debounce to the search input in components/Search.tsx

[tool: grep] "Search" → 2 matches
[tool: read_file] components/Search.tsx
[tool: edit-file-with-ts-morph] add `import debounce from "lodash.debounce"`
[tool: edit_file] components/Search.tsx (wrap onChange in debounce)
Done.
```

No LangChain, no agent framework. Direct Bedrock API calls, hand-rolled message history, tool schemas as Zod objects, ripgrep for search, ts-morph for AST edits.

## How it works

The whole thing is one loop, in `src/agent/engine.ts`:

1. Send the full conversation history plus tool definitions to Claude (via Bedrock).
2. If Claude returns text, print it and stop.
3. If Claude returns `tool_use` blocks, run each tool, append the results to history, go back to step 1.
4. Cap at 50 iterations so a runaway loop can't burn through credits.

Claude is stateless between calls, so the conversation array *is* the context. Everything else in the repo exists to keep that array useful.

**Context management.** Once history crosses 80k tokens, `summarizer.ts` compresses older turns into a single summary message and keeps the last six turns verbatim. Token counting uses `tiktoken`. Individual tool results are truncated to a per-result byte budget so a wide `grep` doesn't poison the next request.

**Retries.** Bedrock throttles under load. The provider layer (`src/providers/claude-provider.ts`) retries up to three times with exponential backoff, and distinguishes throttling from real errors so the loop knows whether to wait or surface the failure.

**Tools.** Each lives in `src/tools/` and implements a small `Tool` interface (`name`, `inputSchema`, `execute`).

| Tool | Purpose |
|---|---|
| `bash` | Run a shell command. Permission-gated by default. |
| `grep` | Wraps `@vscode/ripgrep` for fast text search. |
| `read_file` / `list_files` / `write_file` | Filesystem primitives. Every path goes through `pathUtils.resolveSafe`, which rejects traversal outside the project root. |
| `edit_file` | Exact-string replacement with a unified diff preview before the write commits. |
| `edit-file-with-ts-morph` | AST-aware import editing for TS/JS. Merges with existing imports, places them correctly, handles `import type`. |
| `lineEditor` | Line-based edits for files where exact-string matching is brittle (large config files, generated SQL). |
| `readRange` | Read a slice of a file by line range, so the agent can look at one function without loading the whole file. |
| `memory` | Pin a note the agent wants to carry across turns of the current session. |

The split between `grep`, `ast-grep`, and `ts-morph` is deliberate. Ripgrep is for fast literal lookups. `@ast-grep/napi` is for structural queries ("find every arrow function assigned to a const"). `ts-morph` is for the actual rewrites, so the agent doesn't end up doing brittle regex replacements on import statements.

**Permissions.** Each tool declares a permission level (`auto`, `prompt`, `deny`) in `src/agent/permissions.ts`. `bash` is `prompt` by default, so the agent can't `rm -rf` your repo without you confirming.

Deeper design notes are in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Setup

Requires Node 18+ and AWS credentials with Bedrock model access for Claude Sonnet 4.5.

```bash
git clone https://github.com/manmindersingh01/mini-bot.git
cd mini-bot
npm install

export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

npm run dev
```

Then type at the prompt. `exit` or `quit` to leave, `/clear` to reset history.

## Tech stack

TypeScript, AWS Bedrock (Claude Sonnet 4.5), `commander`, `tiktoken`, `ts-morph`, `@ast-grep/napi`, `@vscode/ripgrep`, `zod`, `diff`.

## Why I built this

I wanted to know what Claude Code actually does under the hood. Reading the docs only gets you so far. Building a stripped-down version, with the same tool-calling loop, the same context-management problem, and the same permission UX, is what made the ideas stick. The result is small enough to read through in an afternoon and complete enough to use on real edits.
