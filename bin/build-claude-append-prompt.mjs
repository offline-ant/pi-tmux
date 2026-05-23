#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const cwd = resolve(process.argv[2] ?? process.cwd());
  const piCliPath = process.env.PI_CLI_PATH;

  if (!piCliPath) {
    throw new Error("PI_CLI_PATH is not set");
  }

  const resolvedCliPath = realpathSync(piCliPath);
  const distDir = dirname(resolvedCliPath);
  const packageRoot = resolve(distDir, "..");

  const [{ loadProjectContextFiles }] = await Promise.all([
    import(pathToFileURL(join(distDir, "core/resource-loader.js")).href),
  ]);

  const agentDir = resolve(homedir(), ".pi/agent");
  const contextFiles = loadProjectContextFiles({ cwd, agentDir });

  const readmePath = join(packageRoot, "README.md");
  const docsPath = join(packageRoot, "docs");
  const examplesPath = join(packageRoot, "examples");

  const contextSection =
    contextFiles.length > 0
      ? [
          "Project context files discovered via pi (read them before substantive work; later entries are more specific):",
          ...contextFiles.map(({ path }) => `- ${path}`),
        ].join("\n")
      : "No AGENTS.md or CLAUDE.md files were discovered via pi's context-file search.";

  const prompt = [
    "You are operating inside a pi-supervised tmux workflow through Claude Code.",
    "Use Claude Code native tools and tool names.",
    "Be concise. Show file paths clearly. Preserve intentional behavior unless the user asks to remove it.",
    "Treat references to pi tool names as conceptual guidance; use the Claude Code equivalent.",
    "For pi-specific questions, read:",
    `- ${readmePath}`,
    `- ${docsPath}`,
    `- ${examplesPath}`,
    contextSection,
    `Working directory: ${cwd}`,
  ].join("\n\n");

  process.stdout.write(prompt);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to build Claude append prompt: ${message}`);
  process.exit(1);
});
