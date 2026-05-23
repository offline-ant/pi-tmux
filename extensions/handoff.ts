/**
 * /handoff — cycle through OFF -> handoff -> WHIP modes.
 *
 * handoff: At 88% context, injects a message telling the agent to spawn a
 *          sibling with a handoff summary and stop.
 *
 * WHIP:    When the agent goes idle (agent_end), spawns a reviewer agent in
 *          tmux that captures this pane's output, reviews it, and decides
 *          whether to send a follow-up prompt to keep work going.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "off" | "handoff" | "whip";
const MODES: Mode[] = ["off", "handoff", "whip"];

const TMUX_SCRIPT = path.resolve(__dirname, "../bin/pi-tmux");

export default function (pi: ExtensionAPI) {
	let mode: Mode = "off";
	let handoffTriggered = false;
	let whipCounter = 0;

	function updateStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) {
		if (mode === "off") {
			ctx.ui.setStatus("handoff", undefined);
		} else if (mode === "handoff") {
			ctx.ui.setStatus("handoff", "handoff");
		} else {
			ctx.ui.setStatus("handoff", "WHIP");
		}
	}

	pi.registerCommand("handoff", {
		description: "Cycle mode: off -> handoff (auto-handoff at 88% context) -> WHIP (reviewer nudges idle agent)",
		handler: async (_args, ctx) => {
			const idx = MODES.indexOf(mode);
			mode = MODES[(idx + 1) % MODES.length];
			handoffTriggered = false;

			updateStatus(ctx);
			ctx.ui.notify(
				mode === "off"
					? "Handoff/WHIP disabled"
					: mode === "handoff"
						? "Handoff mode: will auto-handoff at 88% context"
						: "WHIP mode: reviewer agent will nudge when idle",
				"info",
			);
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		updateStatus(ctx);

		// -- handoff mode: check context and trigger handoff --
		if (mode === "handoff" && !handoffTriggered) {
			const usage = ctx.getContextUsage();
			if (usage && usage.percent !== null && usage.percent >= 88) {
				handoffTriggered = true;
				ctx.ui.notify(`Context at ${Math.round(usage.percent)}% — triggering handoff`, "warning");

				pi.sendUserMessage(
					`CRITICAL: Your context is at ${Math.round(usage.percent)}%. You must hand off NOW.

Do the following immediately:
1. Write a handoff file to ./dev/handoff-<timestamp>.md containing:
   - A summary of the overall plan/goal
   - What has been completed so far
   - What remains to be done, with specific next steps
   - Any important context, decisions, or gotchas the next agent needs to know
   - Relevant file paths and their purposes
2. Spawn a sibling tmux-coding-agent and tell it to read the handoff file and continue the work.
3. Stop working after the sibling is running.

Do NOT skip any of these steps. The sibling agent must be able to pick up exactly where you left off.`,
				);
			}
			return;
		}

		// -- WHIP mode: spawn a reviewer when agent goes idle --
		if (mode === "whip") {
			const lockName = process.env.PI_LOCK_NAME;
			if (!lockName) {
				ctx.ui.notify("WHIP: not running in a tmux pane (no PI_LOCK_NAME), skipping", "warning");
				return;
			}

			whipCounter++;
			const reviewerName = `whip-${whipCounter}`;
			const cwd = process.cwd();

			ctx.ui.notify("WHIP: spawning reviewer agent", "info");

			const result = await pi.exec("bash", [
				TMUX_SCRIPT,
				"coding-agent",
				reviewerName,
				cwd,
			]);

			if (result.code !== 0) {
				ctx.ui.notify(`WHIP: failed to spawn reviewer: ${result.stderr}`, "error");
				return;
			}

			const reviewPrompt = `Do a tmux-capture("${lockName}"). Review its thoughts. If the agent is stuck tell it to spawn a codex and claude review agent to find the best solution. If the agent says its finished, do tmux-send and ask it if its finished with the complete plan, or just a small part of it. If its a small part tell it to commit and write a handoff and spawn a tmux-coding-agent to continue the work.`;

			await pi.exec("bash", [
				TMUX_SCRIPT,
				"send",
				reviewerName,
				reviewPrompt,
			]);
		}
	});
}
