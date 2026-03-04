import * as fs from "node:fs/promises";
import type { Tool } from "./types.js";
import { resolveSafe } from "./pathUtils.js";
import { formatDiff } from "../ui/format.js";

export function createEditFileTool(rootDir: string): Tool {
  return {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match. " +
      "Provide the exact text to find (old_string) and the replacement (new_string). " +
      "The old_string must match exactly one location in the file. " +
      "If it matches multiple locations, include more surrounding context to make it unique. " +
      "Path is relative to the project root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to edit.",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace. Must match exactly one location.",
        },
        new_string: {
          type: "string",
          description: "The replacement string. Use empty string to delete the matched text.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(input) {
      const filePath = input["path"];
      const oldString = input["old_string"];
      const newString = input["new_string"];

      if (typeof filePath !== "string") {
        throw new Error("'path' must be a string.");
      }
      if (typeof oldString !== "string") {
        throw new Error("'old_string' must be a string.");
      }
      if (typeof newString !== "string") {
        throw new Error("'new_string' must be a string.");
      }
      if (oldString === newString) {
        throw new Error("'old_string' and 'new_string' are identical — no change needed.");
      }

      const resolved = resolveSafe(rootDir, filePath);
      const content = await fs.readFile(resolved, "utf-8");

      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        throw new Error(
          "old_string not found in the file. Make sure it matches the file content exactly, " +
          "including whitespace and indentation.",
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `old_string matches ${occurrences} locations in the file. ` +
          "Include more surrounding context to make it unique.",
        );
      }

      const newContent = content.replace(oldString, newString);
      await fs.writeFile(resolved, newContent, "utf-8");

      // Show a colorized diff to the console
      const diff = formatDiff(content, newContent, filePath);
      console.log(diff);

      return `File edited successfully: ${filePath}`;
    },
  };
}
