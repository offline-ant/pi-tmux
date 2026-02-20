/**
 * /supervise — spawn a supervised coding agent in tmux.
 *
 * Usage:  /supervise <task description>
 *
 * Creates .dev/<id>/task.md with the task and guidance, then tells the
 * current agent to spawn a worker and keep it from going dormant.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ID_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomId(): string {
  return (
    ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)] +
    ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
  );
}

function uniqueId(baseDir: string): string {
  for (let i = 0; i < 100; i++) {
    const id = randomId();
    if (!fs.existsSync(path.join(baseDir, id))) return id;
  }
  throw new Error("Failed to find a unique .dev/ id after 100 attempts");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("supervise", {
    description:
      "Spawn a supervised tmux coding agent. Usage: /supervise <task>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /supervise <task description>", "error");
        return;
      }

      const devBase = path.join(ctx.cwd, ".dev");
      const id = uniqueId(devBase);
      const devDir = path.join(devBase, id);
      const taskFile = path.join(devDir, "task.md");

      fs.mkdirSync(devDir, { recursive: true });
      fs.writeFileSync(
        taskFile,
        `
${task}

You are the lead agent. Use tmux coding agent - have them write files to .dev/${id}.
Follow this general outline - but tweak it for your needs:

\`\`\`
parellel investigate;
while plan.incomplete {
    plan;
    review;
};
parellel execute;
\`\`\`

do not stop until task is complete.
When your context is >70% full full write down your status and start a sibling tmux-coding agent
that continues your work then stop.`,
      );

      const relPath = `.dev/${id}/task.md`;
      ctx.ui.notify(`Task written to ${relPath}`, "info");

      pi.sendUserMessage(
        `read '${relPath}' - spawn a tmux-coding-agent to do this task; your only job is to observe the main agent and prevent it from going dormant, and to ensure it follows the >70% context rule`,
      );
    },
  });
}
