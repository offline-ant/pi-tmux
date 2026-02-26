/**
 * /supervise — spawn a supervised coding agent in tmux.
 *
 * Usage:  /supervise <task description>
 *
 * Creates ./dev/scratch/<id>/task.md with the task and guidance, then tells the
 * current agent to spawn a 'main' agent and keep it from going dormant.
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

      const devBase = path.join(process.cwd(), "dev", "scratch");
      const id = uniqueId(devBase);
      const devDir = path.join(devBase, id);
      const taskFile = path.join(devDir, "task.md");

      fs.mkdirSync(devDir, { recursive: true });
      fs.writeFileSync(
        taskFile,
        `
${task || "(supervisor will fill this in from the conversation)"}

You are the lead agent. Use tmux coding agents — have them write files to ./dev/scratch/${id}.

**Priority: architectural quality over speed.** You have the power to spawn
sub-agents. Use that power to investigate properly, explore alternatives, and
build a well-structured solution. Dependencies are not automatically correct —
we can vendor, replace, or change APIs if that's the right thing to do. Do not
rush to the quickest fix — take the time to get the design right.

Follow this general outline — but tweak it for your needs:

\`\`\`
parallel investigate;
while plan.incomplete {
    plan;
    review;
};
parallel execute;
\`\`\`

Do not stop until the task is complete.
When your context is >78% full, write down your status and start a sibling tmux-coding-agent
that continues your work, then stop.`,
      );

      const relPath = path.join(devDir, "task.md");
      ctx.ui.notify(`Task written to ${relPath}`, "info");

      const supervisorMessage = task
        ? `read '${relPath}' — spawn a tmux-coding-agent named 'main' to do this task.`
        : `Write our discussed plan to '${relPath}' (task summary, steps, key decisions), then spawn a tmux-coding-agent named 'main' to execute it.`;

      pi.sendUserMessage(
        `${supervisorMessage} Your jobs as supervisor:
1. Observe the main agent and prevent it from going dormant.
2. Ensure it follows the >78% context rule.
3. **Ensure architectural quality** — if the main agent is rushing to a quick fix instead of building a well-structured solution, nudge it to slow down, investigate alternatives, and get the design right. Dependencies are not automatically correct — vendoring, replacing, or changing APIs is on the table if it's the right call. That's the whole point of this supervised workflow.
4. **Ensure the main agent commits** — when the task is complete, make sure the main agent commits its work before stopping.

Do NOT tell the main agent it has a supervisor.

If you see text appearing in your input buffer (partially typed text), it likely means the user is typing a message to you directly. Just do a semaphore_wait to block and let them finish typing and submit their message.`,
      );
    },
  });
}
