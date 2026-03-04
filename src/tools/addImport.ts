import { Project } from "ts-morph";
import type { Tool } from "./types.js";
import { resolveSafe } from "./pathUtils.js";

export function createAddImportTool(rootDir: string): Tool {
  const project = new Project({ useInMemoryFileSystem: false });

  return {
    name: "edit-file-with-ts-morph",
    description:
      "Safely adds named imports to a TypeScript/JavaScript file using AST manipulation. " +
      "Automatically merges with existing imports from the same module. " +
      "Use this instead of edit_file when you need to add imports — it handles deduplication " +
      "and correct placement without needing to know the existing import block. " +
      "Path is relative to the project root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the TypeScript/JavaScript file.",
        },
        moduleSpecifier: {
          type: "string",
          description:
            "The module to import from, e.g. 'react', './utils.js', 'node:fs'.",
        },
        namedImports: {
          type: "array",
          items: { type: "string" },
          description:
            "Named exports to import, e.g. ['useState', 'useEffect'].",
        },
        defaultImport: {
          type: "string",
          description:
            "Optional default import name, e.g. 'React' for `import React from 'react'`.",
        },
        isTypeOnly: {
          type: "boolean",
          description:
            "If true, adds `import type { ... }` instead of `import { ... }`. Defaults to false.",
        },
      },
      required: ["path", "moduleSpecifier"],
    },
    async execute(input) {
      const filePath = input["path"];
      const moduleSpecifier = input["moduleSpecifier"];
      const namedImports = input["namedImports"] as string[] | undefined;
      const defaultImport = input["defaultImport"] as string | undefined;
      const isTypeOnly = input["isTypeOnly"] as boolean | undefined;

      if (typeof filePath !== "string") {
        throw new Error("'path' must be a string.");
      }
      if (typeof moduleSpecifier !== "string") {
        throw new Error("'moduleSpecifier' must be a string.");
      }
      if (!namedImports?.length && !defaultImport) {
        throw new Error(
          "Provide at least one of 'namedImports' or 'defaultImport'.",
        );
      }

      const resolved = resolveSafe(rootDir, filePath);

      // Load the file into ts-morph (or refresh if already loaded)
      let sourceFile = project.getSourceFile(resolved);
      if (sourceFile) {
        sourceFile.refreshFromFileSystemSync();
      } else {
        sourceFile = project.addSourceFileAtPath(resolved);
      }

      const added: string[] = [];
      const skipped: string[] = [];

      // Find existing import declaration for this module
      const existing = sourceFile.getImportDeclaration(moduleSpecifier);

      if (existing) {
        // Merge into existing import
        if (defaultImport) {
          const current = existing.getDefaultImport();
          if (current) {
            skipped.push(
              `default import '${current.getText()}' (already exists)`,
            );
          } else {
            existing.setDefaultImport(defaultImport);
            added.push(`default import '${defaultImport}'`);
          }
        }

        if (namedImports?.length) {
          const existingNames = new Set(
            existing.getNamedImports().map((n) => n.getName()),
          );
          for (const name of namedImports) {
            if (existingNames.has(name)) {
              skipped.push(`{ ${name} } (already imported)`);
            } else {
              existing.addNamedImport(name);
              added.push(`{ ${name} }`);
            }
          }
        }
      } else {
        // Create a new import declaration
        const structure: {
          moduleSpecifier: string;
          namedImports?: string[];
          defaultImport?: string;
          isTypeOnly?: boolean;
        } = { moduleSpecifier };

        if (namedImports?.length) {
          structure.namedImports = namedImports;
          for (const name of namedImports) {
            added.push(`{ ${name} }`);
          }
        }
        if (defaultImport) {
          structure.defaultImport = defaultImport;
          added.push(`default import '${defaultImport}'`);
        }
        if (isTypeOnly) {
          structure.isTypeOnly = true;
        }

        sourceFile.addImportDeclaration(structure);
      }

      await sourceFile.save();

      // Build result message
      const parts: string[] = [];
      if (added.length > 0) {
        parts.push(`Added ${added.join(", ")} from '${moduleSpecifier}'`);
      }
      if (skipped.length > 0) {
        parts.push(`Skipped ${skipped.join(", ")}`);
      }
      if (added.length === 0 && skipped.length > 0) {
        return `No changes needed: all imports from '${moduleSpecifier}' already exist in ${filePath}. ${parts.join(". ")}.`;
      }

      return `${parts.join(". ")}. File: ${filePath}`;
    },
  };
}
