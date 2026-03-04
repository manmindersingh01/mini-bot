import chalk from "chalk";
import * as Diff from "diff";

// ── Colors & theme ─────────────────────────────────────────────

const theme = {
  primary: chalk.hex("#D97706"), // amber/orange — brand accent
  secondary: chalk.hex("#8B5CF6"), // violet — secondary accent
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  dim: chalk.dim,
  bold: chalk.bold,
  muted: chalk.gray,
  tool: chalk.cyan,
};

// ── Welcome banner ─────────────────────────────────────────────

export function printWelcome(workingDir: string, modelId: string): void {
  const divider = theme.bold("─".repeat(60));

  console.log();
  console.log(divider);
  console.log(
    `  ${theme.primary.bold("◆ mini-claude")}  ${theme.muted("— AI coding assistant by mango man")}`,
  );
  console.log(divider);
  console.log(`  ${theme.dim("cwd")}    ${workingDir}`);
  // console.log(
  //   `  ${theme.dim("model")}  ${theme.muted(formatModelName(modelId))}`,
  // );
  console.log(
    `  ${theme.dim("tips")}   ${theme.muted("type")} ${theme.bold("/clear")} ${theme.muted("to reset,")} ${theme.bold("exit")} ${theme.muted("to quit")}`,
  );
  console.log(divider);
  console.log();
}

function formatModelName(modelId: string): string {
  return modelId.replace(/^us\.anthropic\./, "").replace(/-v\d+:\d+$/, "");
}

// ── User prompt ────────────────────────────────────────────────

export function formatUserPrompt(): string {
  return `${theme.primary.bold(">")} `;
}

// ── Pasted input display ──────────────────────────────────────

export function printPastedInput(text: string, lineCount: number): void {
  const MAX_PREVIEW_LINES = 4;
  const lines = text.split("\n");
  const preview = lines.slice(0, MAX_PREVIEW_LINES);

  console.log();
  console.log(
    `  ${theme.dim("┌─")} ${theme.muted(`Pasted ${lineCount} lines`)} ${theme.dim("─".repeat(Math.max(0, 38 - String(lineCount).length)))}`,
  );
  for (const line of preview) {
    const trimmed = line.length > 70 ? line.slice(0, 67) + "..." : line;
    console.log(`  ${theme.dim("│")} ${theme.muted(trimmed)}`);
  }
  if (lines.length > MAX_PREVIEW_LINES) {
    console.log(
      `  ${theme.dim("│")} ${theme.muted(`... ${lines.length - MAX_PREVIEW_LINES} more lines`)}`,
    );
  }
  console.log(`  ${theme.dim("└" + "─".repeat(50))}`);
}

// ── Assistant response (markdown rendered) ─────────────────────

export function printAssistantResponse(text: string): void {
  console.log();
  const rendered = renderMarkdown(text);
  process.stdout.write(rendered);
}

// ── Streaming text output (line-buffered markdown rendering) ──

let streamingStarted = false;
let streamLineBuffer = "";
let streamInCodeBlock = false;
let streamCodeLang = "";
let streamCodeLines: string[] = [];

export function printStreamingText(delta: string): void {
  if (!streamingStarted) {
    console.log(); // blank line before response
    streamingStarted = true;
  }

  streamLineBuffer += delta;

  // Process complete lines while keeping the incomplete last line in buffer
  const lines = streamLineBuffer.split("\n");
  // Keep the last (possibly incomplete) line in the buffer
  streamLineBuffer = lines.pop() ?? "";

  for (const line of lines) {
    renderStreamLine(line);
  }
}

export function printStreamingEnd(): void {
  if (streamingStarted) {
    // Flush remaining buffer
    if (streamLineBuffer) {
      renderStreamLine(streamLineBuffer);
      streamLineBuffer = "";
    }
    // Close any unclosed code block
    if (streamInCodeBlock && streamCodeLines.length > 0) {
      process.stdout.write(`  ${chalk.dim("┌")}${streamCodeLang ? chalk.dim(` ${streamCodeLang} `) : ""}${chalk.dim("─".repeat(Math.max(0, 50 - streamCodeLang.length - 3)))}\n`);
      for (const cl of streamCodeLines) {
        process.stdout.write(`  ${chalk.dim("│")} ${chalk.yellowBright(cl)}\n`);
      }
      process.stdout.write(`  ${chalk.dim("└" + "─".repeat(50))}\n`);
      streamInCodeBlock = false;
      streamCodeLang = "";
      streamCodeLines = [];
    }
    process.stdout.write("\n");
    streamingStarted = false;
  }
}

/** Render a single completed line with markdown formatting */
function renderStreamLine(line: string): void {
  // Handle code block fences
  if (line.trimStart().startsWith("```")) {
    if (!streamInCodeBlock) {
      streamInCodeBlock = true;
      streamCodeLang = line.trimStart().slice(3).trim();
      streamCodeLines = [];
      return;
    } else {
      // Close code block
      const label = streamCodeLang ? chalk.dim(` ${streamCodeLang} `) : "";
      process.stdout.write(
        `  ${chalk.dim("┌")}${label}${chalk.dim("─".repeat(Math.max(0, 50 - streamCodeLang.length - 3)))}\n`,
      );
      for (const cl of streamCodeLines) {
        process.stdout.write(`  ${chalk.dim("│")} ${chalk.yellowBright(cl)}\n`);
      }
      process.stdout.write(`  ${chalk.dim("└" + "─".repeat(50))}\n`);
      streamInCodeBlock = false;
      streamCodeLang = "";
      streamCodeLines = [];
      return;
    }
  }

  if (streamInCodeBlock) {
    streamCodeLines.push(line);
    return;
  }

  // Blank line
  if (line.trim() === "") {
    process.stdout.write("\n");
    return;
  }

  // Headers
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    const content = renderInline(headingMatch[2]!);
    if (level === 1) {
      process.stdout.write(chalk.bold.cyan.underline(content) + "\n");
    } else if (level === 2) {
      process.stdout.write(chalk.bold.cyan(content) + "\n");
    } else {
      process.stdout.write(chalk.bold(content) + "\n");
    }
    return;
  }

  // Horizontal rule
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    process.stdout.write(chalk.dim("─".repeat(50)) + "\n");
    return;
  }

  // Blockquote
  if (line.trimStart().startsWith("> ")) {
    const content = renderInline(line.replace(/^\s*>\s?/, ""));
    process.stdout.write(`  ${chalk.dim("│")} ${chalk.gray.italic(content)}\n`);
    return;
  }

  // Unordered list
  const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (ulMatch) {
    const indent = ulMatch[1]!;
    const content = renderInline(ulMatch[2]!);
    const depth = Math.floor(indent.length / 2);
    const bullet = depth === 0 ? "●" : depth === 1 ? "○" : "■";
    process.stdout.write(`  ${"  ".repeat(depth)}${chalk.cyan(bullet)} ${content}\n`);
    return;
  }

  // Ordered list
  const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (olMatch) {
    const indent = olMatch[1]!;
    const num = olMatch[2]!;
    const content = renderInline(olMatch[3]!);
    const depth = Math.floor(indent.length / 2);
    process.stdout.write(`  ${"  ".repeat(depth)}${chalk.cyan(num + ".")} ${content}\n`);
    return;
  }

  // Normal text
  process.stdout.write(renderInline(line) + "\n");
}

// ── Custom Markdown → Terminal Renderer ─────────────────────
//
// Handles: headers, bold, italic, inline code, code blocks,
// bullet/numbered lists, blockquotes, links, horizontal rules.
// No external dependencies — just chalk.

function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // ── Code block fences ───────────────────────────────
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.trimStart().slice(3).trim();
        codeLines = [];
        continue;
      } else {
        // Close code block — render it
        const label = codeLang ? chalk.dim(` ${codeLang} `) : "";
        out.push(
          `  ${chalk.dim("┌")}${label}${chalk.dim("─".repeat(Math.max(0, 50 - codeLang.length - 3)))}`,
        );
        for (const cl of codeLines) {
          out.push(`  ${chalk.dim("│")} ${chalk.yellowBright(cl)}`);
        }
        out.push(`  ${chalk.dim("└" + "─".repeat(50))}`);
        inCodeBlock = false;
        codeLang = "";
        codeLines = [];
        continue;
      }
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // ── Blank line ──────────────────────────────────────
    if (line.trim() === "") {
      out.push("");
      continue;
    }

    // ── Headers ─────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const content = renderInline(headingMatch[2]!);
      if (level === 1) {
        out.push(chalk.bold.cyan.underline(content));
      } else if (level === 2) {
        out.push(chalk.bold.cyan(content));
      } else {
        out.push(chalk.bold(content));
      }
      continue;
    }

    // ── Horizontal rule ─────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(chalk.dim("─".repeat(50)));
      continue;
    }

    // ── Blockquote ──────────────────────────────────────
    if (line.trimStart().startsWith("> ")) {
      const content = renderInline(line.replace(/^\s*>\s?/, ""));
      out.push(`  ${chalk.dim("│")} ${chalk.gray.italic(content)}`);
      continue;
    }

    // ── Unordered list ──────────────────────────────────
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      const indent = ulMatch[1]!;
      const content = renderInline(ulMatch[2]!);
      const depth = Math.floor(indent.length / 2);
      const bullet = depth === 0 ? "●" : depth === 1 ? "○" : "■";
      out.push(`  ${"  ".repeat(depth)}${chalk.cyan(bullet)} ${content}`);
      continue;
    }

    // ── Ordered list ────────────────────────────────────
    const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (olMatch) {
      const indent = olMatch[1]!;
      const num = olMatch[2]!;
      const content = renderInline(olMatch[3]!);
      const depth = Math.floor(indent.length / 2);
      out.push(`  ${"  ".repeat(depth)}${chalk.cyan(num + ".")} ${content}`);
      continue;
    }

    // ── Normal paragraph text ───────────────────────────
    out.push(renderInline(line));
  }

  // Handle unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    out.push(`  ${chalk.dim("┌" + "─".repeat(50))}`);
    for (const cl of codeLines) {
      out.push(`  ${chalk.dim("│")} ${chalk.yellowBright(cl)}`);
    }
    out.push(`  ${chalk.dim("└" + "─".repeat(50))}`);
  }

  return out.join("\n") + "\n";
}

/** Render inline markdown: bold, italic, code, links, strikethrough */
function renderInline(text: string): string {
  return (
    text
      // Inline code (must come before bold/italic to avoid conflicts)
      .replace(/`([^`]+)`/g, (_m, code: string) =>
        chalk.bgGray.yellowBright(` ${code} `),
      )
      // Bold + italic
      .replace(/\*\*\*(.+?)\*\*\*/g, (_m, t: string) => chalk.bold.italic(t))
      // Bold
      .replace(/\*\*(.+?)\*\*/g, (_m, t: string) => chalk.bold.white(t))
      .replace(/__(.+?)__/g, (_m, t: string) => chalk.bold.white(t))
      // Italic
      .replace(/\*(.+?)\*/g, (_m, t: string) => chalk.italic.blueBright(t))
      .replace(/_(.+?)_/g, (_m, t: string) => chalk.italic.blueBright(t))
      // Strikethrough
      .replace(/~~(.+?)~~/g, (_m, t: string) => chalk.strikethrough.dim(t))
      // Links [text](url)
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_m, label: string, url: string) =>
          `${chalk.cyan(label)} ${chalk.dim("(")}${chalk.cyan.underline(url)}${chalk.dim(")")}`,
      )
  );
}

// ── Tool call logging ──────────────────────────────────────────

export function printToolCall(
  toolName: string,
  input: Record<string, unknown>,
): void {
  const args = formatToolArgs(input);
  console.log(
    `  ${theme.tool(">")} ${theme.tool.bold(toolName)} ${theme.dim(args)}`,
  );
}

export function printToolResult(_toolName: string, result: string, isError: boolean): void {
  if (isError) {
    const preview = result.length > 120 ? result.slice(0, 117) + "..." : result;
    console.log(
      `  ${theme.error("✗")} ${theme.dim(preview)}`,
    );
    return;
  }
  // Show a compact summary based on size
  const lines = result.split("\n");
  if (lines.length === 1) {
    // Single line results — show inline (e.g. "File written successfully: ...")
    const trimmed = result.length > 80 ? result.slice(0, 77) + "..." : result;
    console.log(`  ${theme.success("✓")} ${theme.dim(trimmed)}`);
  } else if (lines.length <= 5) {
    // Small results — show first line + count
    const first = lines[0]!.length > 80 ? lines[0]!.slice(0, 77) + "..." : lines[0]!;
    console.log(`  ${theme.success("✓")} ${theme.dim(first)} ${theme.dim(`(${lines.length} lines)`)}`);
  } else {
    console.log(
      `  ${theme.success("✓")} ${theme.dim(`${lines.length} lines`)}`,
    );
  }
}

export function printToolError(toolName: string, message: string): void {
  console.log(
    `  ${theme.error("✗")} ${theme.error(toolName)}: ${theme.dim(message)}`,
  );
}

export function printUnknownTool(toolName: string): void {
  console.log(
    `  ${theme.warning("?")} ${theme.warning("Unknown tool:")} ${toolName}`,
  );
}

function formatToolArgs(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";

  const [key, val] = entries[0]!;
  const str = typeof val === "string" ? val : JSON.stringify(val);
  const short = str.length > 60 ? str.slice(0, 57) + "..." : str;
  const extra =
    entries.length > 1 ? ` ${theme.dim(`+${entries.length - 1} more`)}` : "";
  return `${key}=${short}${extra}`;
}

// ── Token usage ────────────────────────────────────────────────

export function printTokenUsage(
  inputTokens: number,
  outputTokens: number,
): void {
  const total = inputTokens + outputTokens;
  console.log();
  console.log(
    `  ${theme.dim("tokens")} ${theme.muted(`${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out / ${total.toLocaleString()} total`)}`,
  );
}

// ── Diff display ───────────────────────────────────────────────

export function formatDiff(
  oldText: string,
  newText: string,
  filePath: string,
): string {
  const patch = Diff.createPatch(filePath, oldText, newText, "before", "after");
  return colorizePatch(patch);
}

function colorizePatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return theme.bold(line);
      }
      if (line.startsWith("@@")) {
        return theme.secondary(line);
      }
      if (line.startsWith("+")) {
        return theme.success(line);
      }
      if (line.startsWith("-")) {
        return theme.error(line);
      }
      return theme.dim(line);
    })
    .join("\n");
}

// ── Permission prompt ──────────────────────────────────────────

export function formatPermissionPrompt(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const args = formatToolArgs(input);
  return `  ${theme.warning("!")} ${theme.warning.bold("Allow")} ${theme.tool.bold(toolName)} ${theme.dim(args)} ${theme.dim("?")} [${theme.success("y")}/${theme.error("n")}/${theme.primary("a")}lways/${theme.dim("exit")}] `;
}

// ── Context / status messages ──────────────────────────────────

export function printContextSummary(
  tokensBefore: number,
  tokensAfter: number,
): void {
  console.log(
    `  ${theme.dim("~")} ${theme.dim(`Context summarized: ${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens`)}`,
  );
}

export function printError(message: string): void {
  console.log();
  console.log(`  ${theme.error.bold("Error:")} ${message}`);
  console.log();
}

export function printConversationCleared(): void {
  console.log(`  ${theme.dim("Conversation cleared")}`);
  console.log();
}

// ── Spinner ────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  start(message: string): void {
    this.stop();
    // Hide cursor during spinner for cleaner display
    process.stdout.write("\x1b[?25l");
    process.stdout.write(
      `  ${theme.primary(SPINNER_FRAMES[0]!)} ${theme.dim(message)}`,
    );
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      process.stdout.write(
        `\r  ${theme.primary(SPINNER_FRAMES[this.frame]!)} ${theme.dim(message)}`,
      );
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      // Clear spinner line and restore cursor visibility
      process.stdout.write("\r\x1b[2K\x1b[?25h");
    }
  }
}
