import { get_encoding } from "tiktoken";
import type { UniversalMessage, ContentBlock } from "../types.js";

// cl100k_base is the closest publicly available encoding to Claude's tokenizer.
// It won't be exact, but it's far more accurate than character-based heuristics.
const encoder = get_encoding("cl100k_base");

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

export function countMessageTokens(messages: UniversalMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += countTokens(msg.content);
    } else {
      for (const block of msg.content) {
        total += countBlockTokens(block);
      }
    }
    total += 4; // per-message overhead (role, framing tokens)
  }
  return total;
}

function countBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return countTokens(block.text);
    case "tool_use":
      return countTokens(block.name) + countTokens(JSON.stringify(block.input));
    case "tool_result":
      return countTokens(block.content);
  }
}

const MAX_TOOL_RESULT_CHARS = 100_000;

/**
 * Middle-truncation: keeps the beginning and end of a string,
 * which tends to preserve the most informative parts (headers, summaries, final output).
 */
export function truncateToolResult(result: string, maxChars: number = MAX_TOOL_RESULT_CHARS): string {
  if (result.length <= maxChars) return result;
  const half = Math.floor(maxChars / 2);
  const removed = result.length - maxChars;
  return (
    result.slice(0, half) +
    `\n\n... [${removed} characters truncated] ...\n\n` +
    result.slice(-half)
  );
}
