# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**mini-claude-code** is a CLI tool that acts as a code assistant for modifying and editing TypeScript codebases. It uses a combination of text search, structural code analysis, and AST-based code transformation.

## Build & Run

```bash
npm run dev          # Build (tsc) and run the CLI
npx tsc -b           # Build only
npx tsc --noEmit     # Type-check without emitting
```

No test runner is configured yet.

## Architecture

- **Source:** `src/` → **Output:** `dist/`
- **Module system:** ESM via `"module": "nodenext"` with strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`)
- **Entry point:** `src/index.ts`

## Core Libraries & Their Roles

| Library | Role | When to use |
|---|---|---|
| `commander` | CLI framework | Defining commands, subcommands, options, and argument parsing |
| `glob` | File discovery | Finding files by pattern (e.g. `**/*.ts`) |
| `@vscode/ripgrep` | Text search ("The Eye") | Fast string/regex search across files — finds literal text like `"TODO"`, `"error"`, variable names. Language-agnostic, works on any file |
| `@ast-grep/napi` | Structural search ("The Brain") | AST-aware pattern matching — understands code structure. Use when you need to find a `function`, `class`, or specific syntax pattern regardless of formatting |
| `ts-morph` | Code transformation | Reading, modifying, and writing TypeScript files via AST manipulation. Use for programmatic code edits (rename, refactor, add/remove code) |

**Key distinction:** Use ripgrep for fast text lookups. Use ast-grep when the query is structural (e.g. "find all arrow functions assigned to a const"). Use ts-morph when you need to *modify* code, not just find it.

## TypeScript Conventions

- All imports must use explicit extensions (enforced by `verbatimModuleSyntax` + `nodenext` resolution): `import { foo } from "./bar.js"`
- Use `import type` for type-only imports
