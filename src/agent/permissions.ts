export type PermissionLevel = "read" | "write" | "execute";

/** Result of a permission prompt. */
export type PermissionResult = "allowed" | "denied" | "abort";

export interface PermissionConfig {
  /** Permission levels that are auto-allowed without prompting the user. */
  autoAllow: Set<PermissionLevel>;
  /** Callback to prompt the user for permission. */
  promptUser: (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
}

const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  list_files: "read",
  read_file: "read",
  read_file_range: "read",
  grep: "read",
  write_file: "write",
  edit_file: "write",
  replace_lines: "write",
  "edit-file-with-ts-morph": "write",
  add_import: "write",
  bash: "execute",
  save_memory: "write",
  recall_memory: "read",
  task: "read", // sub-agents are read-only by default
};

export function getToolPermissionLevel(toolName: string): PermissionLevel {
  return TOOL_PERMISSIONS[toolName] ?? "execute";
}
