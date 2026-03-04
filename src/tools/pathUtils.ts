import * as path from "node:path";

export function resolveSafe(rootDir: string, userPath: string): string {
  const resolved = path.resolve(rootDir, userPath);
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    throw new Error(`Path "${userPath}" is outside the project directory.`);
  }
  return resolved;
}
