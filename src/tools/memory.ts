import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "./types.js";

const MEMORY_DIR = ".mini-claude";
const MEMORY_FILE = "memory.md";

function getMemoryPath(rootDir: string): string {
  return path.join(rootDir, MEMORY_DIR, MEMORY_FILE);
}

export function createSaveMemoryTool(rootDir: string): Tool {
  return {
    name: "save_memory",
    description:
      "Save a key-value memory entry to .mini-claude/memory.md for persistence across sessions. " +
      "Use this to remember important context: file paths, decisions made, task progress, user preferences. " +
      "Each entry has a key (short label) and value (concise fact). Entries with the same key are updated in place.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Short label for this memory entry (e.g., 'architecture', 'current_task', 'user_pref')",
        },
        value: {
          type: "string",
          description: "Concise fact or note to remember (keep it brief — facts, not prose)",
        },
      },
      required: ["key", "value"],
    },
    async execute(input: Record<string, unknown>): Promise<string> {
      const key = String(input["key"] ?? "");
      const value = String(input["value"] ?? "");

      if (!key || !value) {
        throw new Error("Both 'key' and 'value' are required");
      }

      const memPath = getMemoryPath(rootDir);

      // Ensure directory exists
      await fs.mkdir(path.join(rootDir, MEMORY_DIR), { recursive: true });

      // Read existing memory or start fresh
      let content: string;
      try {
        content = await fs.readFile(memPath, "utf-8");
      } catch {
        content = "# Mini-Claude Memory\n\n";
      }

      // Check if key already exists — update in place
      const keyPattern = new RegExp(`^- \\*\\*${escapeRegex(key)}\\*\\*: .+$`, "m");
      const newEntry = `- **${key}**: ${value}`;

      if (keyPattern.test(content)) {
        content = content.replace(keyPattern, newEntry);
      } else {
        // Append new entry
        content = content.trimEnd() + "\n" + newEntry + "\n";
      }

      await fs.writeFile(memPath, content, "utf-8");
      return `Memory saved: ${key} = ${value}`;
    },
  };
}

export function createRecallMemoryTool(rootDir: string): Tool {
  return {
    name: "recall_memory",
    description:
      "Read all saved memory entries from .mini-claude/memory.md. " +
      "Call this at the start of a session to load context from previous sessions. " +
      "Returns all stored key-value pairs, or a message if no memory exists yet.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(): Promise<string> {
      const memPath = getMemoryPath(rootDir);
      try {
        const content = await fs.readFile(memPath, "utf-8");
        return content.trim() || "No memory entries found.";
      } catch {
        return "No memory file exists yet. Use save_memory to create one.";
      }
    },
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
