import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { generateMessage } from "../providers/claude-provider.js";
import { CLAUDE_MODELS } from "../types.js";
import type { UniversalMessage, ContentBlock } from "../types.js";

const SUMMARIZATION_PROMPT =
  "Summarize the following conversation between a user and a coding assistant. " +
  "Focus on: (1) what files were discussed or modified, (2) key decisions made, " +
  "(3) current state of the task. Be concise but preserve all technical details " +
  "that would be needed to continue the conversation.";

export async function summarizeHistory(
  client: BedrockRuntimeClient,
  messages: UniversalMessage[],
  modelId: string = CLAUDE_MODELS.CLAUDE_3_5_HAIKU,
): Promise<string> {
  const transcript = serializeMessages(messages);

  const response = await generateMessage(
    client,
    [{ role: "user", content: `${SUMMARIZATION_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>` }],
    modelId,
    { maxTokens: 2048, temperature: 0 },
  );

  return response.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function serializeMessages(messages: UniversalMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg.role.toUpperCase();
      if (typeof msg.content === "string") {
        return `${role}: ${msg.content}`;
      }
      return `${role}: ${msg.content.map(blockToString).join("\n")}`;
    })
    .join("\n\n");
}

function blockToString(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_use":
      return `[Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`;
    case "tool_result": {
      const preview = block.content.slice(0, 500);
      return `[Tool result: ${preview}${block.content.length > 500 ? "..." : ""}]`;
    }
  }
}
