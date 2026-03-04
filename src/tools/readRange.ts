import * as fs from "node:fs/promises";
import { resolveSafe } from "./pathUtils.js";
import type { Tool } from "./types.js";

export function createReadRangeTool(rootDir: string): Tool {
  return {
    name: "read_file_range",
    description:
      "Reads a specific range of lines from a file. Use this to read large files efficiently " +
      "instead of reading the whole file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to file" },
        start_line: {
          type: "number",
          description: "1-based line number to start reading",
        },
        end_line: {
          type: "number",
          description: "1-based line number to stop reading (inclusive)",
        },
      },
      required: ["path", "start_line", "end_line"],
    },
    async execute(input) {
      const path = input.path;
      const startLine = input.start_line;
      const endLine = input.end_line;

      if (typeof path !== "string") {
        throw new Error("path must be a string");
      }
      if (typeof startLine !== "number" || typeof endLine !== "number") {
        throw new Error("start_line and end_line must be numbers");
      }

      const resolved = resolveSafe(rootDir, path);
      const content = await fs.readFile(resolved, "utf-8");
      const lines = content.split("\n");

      if (startLine < 1 || startLine > lines.length) {
        throw new Error(
          `Start line ${startLine} is out of bounds (file has ${lines.length} lines)`,
        );
      }
      if (endLine < startLine) {
        throw new Error(
          `End line ${endLine} must be >= start line ${startLine}`,
        );
      }

      const clampedEnd = Math.min(endLine, lines.length);
      const selectedLines = lines.slice(startLine - 1, clampedEnd);

      return selectedLines
        .map((line, index) => `${startLine + index} | ${line}`)
        .join("\n");
    },
  };
}
