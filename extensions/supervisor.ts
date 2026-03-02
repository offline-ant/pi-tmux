/**
 * /supervise — spawn a supervised coding agent in tmux.
 *
 * Usage:  /supervise <task description>
 *
 * Tells the current agent to spawn a 'main' coding agent and keep it on track.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("supervise", {
    description:
      "Spawn a supervised tmux coding agent. Usage: /supervise <task>",
    handler: async (args, _ctx) => {
      const task = (args ?? "").trim();

      const supervisorMessage = task
        ? `Spawn a tmux-coding-agent named 'main' to: ${task}`
        : `Spawn a tmux-coding-agent named 'main' to execute the plan we just discussed.`;

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
