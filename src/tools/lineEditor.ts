import * as fs from "node:fs/promises";
import { resolveSafe } from "./pathUtils.js";
import type { Tool } from "./types.js";

export function createLineEditTool(rootDir: string): Tool {
  return {
    name: "replace_lines",
    description:
      "Replaces a specific range of lines with new code. " +
      "Be careful: the line numbers must match the file exactly.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        start_line: {
          type: "number",
          description: "The first line to replace (1-based)",
        },
        end_line: {
          type: "number",
          description: "The last line to replace (1-based, inclusive)",
        },
        new_code: {
          type: "string",
          description: "The new code to insert in place of the replaced lines",
        },
      },
      required: ["path", "start_line", "end_line", "new_code"],
    },
    async execute(input) {
      const path = input.path;
      const startLine = input.start_line;
      const endLine = input.end_line;
      const newCode = input.new_code;

      if (typeof path !== "string") {
        throw new Error("path must be a string");
      }
      if (typeof startLine !== "number" || typeof endLine !== "number") {
        throw new Error("start_line and end_line must be numbers");
      }
      if (typeof newCode !== "string") {
        throw new Error("new_code must be a string");
      }

      const resolved = resolveSafe(rootDir, path);
      const content = await fs.readFile(resolved, "utf-8");
      const lines = content.split("\n");

      if (startLine < 1 || endLine > lines.length || startLine > endLine) {
        throw new Error(
          `Invalid line range: ${startLine}-${endLine}. File has ${lines.length} lines.`,
        );
      }

      const before = lines.slice(0, startLine - 1);
      const after = lines.slice(endLine);
      const newLines = newCode.split("\n");

      const finalContent = [...before, ...newLines, ...after].join("\n");
      await fs.writeFile(resolved, finalContent, "utf-8");

      return `Successfully replaced lines ${startLine}-${endLine} in ${path}`;
    },
  };
}
