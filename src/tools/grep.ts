import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import type { Tool } from "./types.js";
import { resolveSafe } from "./pathUtils.js";

const require = createRequire(import.meta.url);
const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };

const MAX_OUTPUT_CHARS = 100_000;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... [truncated, ${text.length} chars total]`;
}

export function createGrepTool(rootDir: string): Tool {
  return {
    name: "grep",
    description:
      "Search file contents using ripgrep. " +
      "Supports regex patterns by default, or literal strings with fixed_string=true. " +
      "Returns matching lines with file names and line numbers. " +
      "Use this to find function definitions, variable usage, error messages, etc.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The search pattern (regex by default).",
        },
        path: {
          type: "string",
          description:
            "Subdirectory or file to search in, relative to project root. Defaults to entire project.",
        },
        include: {
          type: "string",
          description: "Glob pattern to filter files (e.g. '*.ts', '*.{js,jsx}').",
        },
        context_lines: {
          type: "number",
          description: "Number of context lines around each match (default 2, max 10).",
        },
        fixed_string: {
          type: "boolean",
          description: "Treat pattern as a literal string, not a regex.",
        },
      },
      required: ["pattern"],
    },
    async execute(input) {
      const pattern = input["pattern"];
      if (typeof pattern !== "string") {
        throw new Error("'pattern' must be a string.");
      }

      const searchPath = typeof input["path"] === "string" ? input["path"] : ".";
      const include = typeof input["include"] === "string" ? input["include"] : undefined;
      const rawContext = typeof input["context_lines"] === "number" ? input["context_lines"] : 2;
      const contextLines = Math.max(0, Math.min(rawContext, 10));
      const fixedString = input["fixed_string"] === true;

      const resolvedPath = resolveSafe(rootDir, searchPath);

      const args: string[] = [
        pattern,
        "--color", "never",
        "--line-number",
        "--with-filename",
        "-C", String(contextLines),
      ];

      if (fixedString) {
        args.push("--fixed-strings");
      }

      if (include) {
        args.push("--glob", include);
      }

      // Default exclusions
      args.push("--glob", "!node_modules");
      args.push("--glob", "!.git");
      args.push("--glob", "!dist");

      args.push(resolvedPath);

      return new Promise<string>((resolve) => {
        execFile(rgPath, args, { maxBuffer: 5_242_880, timeout: 30_000 }, (error, stdout, stderr) => {
          // ripgrep exits with code 1 when no matches found — that's not an error
          if (error && (error as { code?: number }).code !== 1) {
            const msg = stderr.trim() || (error as Error).message;
            resolve(`Search error: ${msg}`);
            return;
          }

          if (!stdout.trim()) {
            resolve("No matches found.");
            return;
          }

          resolve(truncate(stdout, MAX_OUTPUT_CHARS));
        });
      });
    },
  };
}
