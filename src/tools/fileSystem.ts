import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";
import type { Tool } from "./types.js";
import { resolveSafe } from "./pathUtils.js";

// ── list_files ─────────────────────────────────────────────────

export function createListFilesTool(rootDir: string): Tool {
  return {
    name: "list_files",
    description:
      "List files in the project directory matching a glob pattern. " +
      "Returns relative paths, one per line. " +
      "Use '**/*.ts' for all TypeScript files, '**/*' for everything, etc.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files (e.g. '**/*.ts', 'src/**/*'). Defaults to '**/*'.",
        },
      },
      required: [],
    },
    async execute(input) {
      const pattern = (input["pattern"] as string | undefined) ?? "**/*";
      const files = await glob(pattern, {
        cwd: rootDir,
        nodir: true,
        ignore: ["node_modules/**", ".git/**", "dist/**"],
      });
      if (files.length === 0) {
        return "No files found matching the pattern.";
      }
      return files.sort().join("\n");
    },
  };
}

// ── read_file ──────────────────────────────────────────────────

export function createReadFileTool(rootDir: string): Tool {
  return {
    name: "read_file",
    description:
      "Read the contents of a file. Path is relative to the project root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to read.",
        },
      },
      required: ["path"],
    },
    async execute(input) {
      const filePath = input["path"];
      if (typeof filePath !== "string") {
        throw new Error("'path' must be a string.");
      }
      const resolved = resolveSafe(rootDir, filePath);
      const content = await fs.readFile(resolved, "utf-8");
      return content;
    },
  };
}

// ── write_file ─────────────────────────────────────────────────

export function createWriteFileTool(rootDir: string): Tool {
  return {
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories if needed. " +
      "Path is relative to the project root. " +
      "Use this to create new files or overwrite existing ones.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to write.",
        },
        content: {
          type: "string",
          description: "The full content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
    async execute(input) {
      const filePath = input["path"];
      const content = input["content"];
      if (typeof filePath !== "string") {
        throw new Error("'path' must be a string.");
      }
      if (typeof content !== "string") {
        throw new Error("'content' must be a string.");
      }
      const resolved = resolveSafe(rootDir, filePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      return `File written successfully: ${filePath}`;
    },
  };
}
