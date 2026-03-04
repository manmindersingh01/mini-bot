import { execFile } from "node:child_process";
import type { Tool } from "./types.js";

const DEFAULT_TIMEOUT = 60_000;
const MAX_TIMEOUT = 300_000;
const MAX_BUFFER = 5_242_880; // 5 MB
const MAX_OUTPUT_CHARS = 50_000;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... [truncated, ${text.length} chars total]`;
}

export function createBashTool(rootDir: string): Tool {
  return {
    name: "bash",
    description:
      "Execute a bash command in the project directory. " +
      "Returns stdout, stderr, and exit code. " +
      "Use this for running builds, tests, git commands, installing packages, etc. " +
      "Commands run with a timeout (default 60s, max 300s). " +
      "Always check the exit code — non-zero means failure.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 60000, max 300000).",
        },
      },
      required: ["command"],
    },
    async execute(input) {
      const command = input["command"];
      if (typeof command !== "string") {
        throw new Error("'command' must be a string.");
      }

      const rawTimeout = typeof input["timeout"] === "number" ? input["timeout"] : DEFAULT_TIMEOUT;
      const timeout = Math.max(1_000, Math.min(rawTimeout, MAX_TIMEOUT));

      return new Promise<string>((resolve) => {
        execFile(
          "/bin/bash",
          ["-c", command],
          { cwd: rootDir, timeout, maxBuffer: MAX_BUFFER },
          (error, stdout, stderr) => {
            const exitCode = error
              ? (error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "maxBuffer exceeded"
                : ("exitCode" in error ? (error as { exitCode?: number }).exitCode ?? 1 : 1)
              : 0;

            const out = truncate(stdout, MAX_OUTPUT_CHARS);
            const err = truncate(stderr, MAX_OUTPUT_CHARS);

            const parts = [`Exit code: ${exitCode}`];
            if (out) parts.push(`STDOUT:\n${out}`);
            if (err) parts.push(`STDERR:\n${err}`);

            resolve(parts.join("\n\n"));
          },
        );
      });
    },
  };
}
