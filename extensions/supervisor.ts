/**
 * /supervise — spawn a supervised coding agent in tmux.
 *
 * Usage:  /supervise <task description>
 *
 * Tells the current agent to spawn a 'main' coding agent and keep it on track.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("supervise", {
    description:
      "Spawn a supervised tmux coding agent. Usage: /supervise <task>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();

      const supervisorMessage = task
        ? `Spawn a tmux-coding-agent named 'main' to: ${task}`
        : `Spawn a tmux-coding-agent named 'main' to execute the plan we just discussed in phases in serial`;

      const message = `${supervisorMessage} Your jobs as supervisor:
1. Observe the main agent and prevent it from going dormant.
2. Ensure it stays below 78% context use. If it exceeds it ask it to write a handoff.md and spawn a new agent to continue its work.
3. **Ensure architectural quality** — if the main agent is rushing to a quick fix instead of building a well-structured solution, nudge it to slow down, investigate alternatives, and get the design right. Dependencies are not automatically correct — vendoring, replacing, or changing APIs is on the table if it's the right call. That's the whole point of this supervised workflow.
4. **Ensure the main agent commits** — when the task is complete, make sure the main agent commits its work before stopping.

Do NOT tell the main agent it has a supervisor.

You may decide to pause when a major unforseen blocker or design choice is uncovered.

You are done when all phases of the plan have been fully implemented, relevant specs & documents updated, and everything commited. 
`;

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
      } else {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /supervise message", "info");
      }
    },
  });
}
