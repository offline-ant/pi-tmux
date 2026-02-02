/**
 * Tmux Extension
 *
 * Provides tools for running long-running commands in tmux windows.
 * Only works when pi is running inside a tmux session (TMUX env var set).
 *
 * Tools:
 *   tmux-bash  - Create a tmux window and run a command
 *   tmux-capture - Capture output from a tmux window
 *   tmux-send  - Send keys/text to a tmux window
 *   tmux-kill  - Kill a tmux window
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions/tmux.ts
 *
 * Requirements:
 *   - Must be running inside a tmux session (TMUX env var set)
 *   - tmux must be installed
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

// Track active windows
const activeWindows = new Map<string, { created: number }>();

function isTmuxAvailable(): boolean {
	return !!process.env.TMUX;
}

function windowExists(name: string): boolean {
	return activeWindows.has(name);
}

// tmux-bash parameters
const tmuxBashParams = Type.Object({
	name: Type.String({ description: "Name for the tmux window (used to identify it later)" }),
	command: Type.String({ description: "Command to execute in the tmux window" }),
});
export type TmuxBashInput = Static<typeof tmuxBashParams>;

// tmux-capture parameters
const tmuxCaptureParams = Type.Object({
	name: Type.String({ description: "Name of the tmux window to capture output from" }),
	lines: Type.Optional(Type.Number({ description: "Number of lines to capture (default: 500)" })),
});
export type TmuxCaptureInput = Static<typeof tmuxCaptureParams>;

// tmux-send parameters
const tmuxSendParams = Type.Object({
	name: Type.String({ description: "Name of the tmux window to send to" }),
	text: Type.String({ description: "Text or keys to send (e.g., 'ls -la', 'Enter', 'C-c' for Ctrl+C)" }),
	enter: Type.Optional(Type.Boolean({ description: "Whether to press Enter after sending text (default: true)" })),
});
export type TmuxSendInput = Static<typeof tmuxSendParams>;

// tmux-kill parameters
const tmuxKillParams = Type.Object({
	name: Type.String({ description: "Name of the tmux window to kill" }),
});
export type TmuxKillInput = Static<typeof tmuxKillParams>;

export default function (pi: ExtensionAPI) {
	// Check tmux availability on session start
	pi.on("session_start", async (_event, ctx) => {
		if (!isTmuxAvailable()) {
			ctx.ui.notify("tmux extension: Not running in tmux session (TMUX env not set)", "warning");
		}
	});

	// tmux-bash: Create window and run command
	pi.registerTool({
		name: "tmux-bash",
		label: "Tmux Bash",
		description:
			"Create a new tmux window with the given name and execute a command. Use for long-running processes. The window stays open after the command completes so you can capture output. Requires running inside tmux.",
		parameters: tmuxBashParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!isTmuxAvailable()) {
				return {
					content: [{ type: "text", text: "Error: Not running inside a tmux session. TMUX env variable not set." }],
					details: { error: "no_tmux" },
					isError: true,
				};
			}

			const { name, command } = params;

			// Check if window already exists
			if (windowExists(name)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Window '${name}' already exists. Use tmux-send to send commands, tmux-capture to get output, or tmux-kill to close it first.`,
						},
					],
					details: { error: "window_exists", name },
					isError: true,
				};
			}

			try {
				// Create new window with the given name
				// Use remain-on-exit so window stays open after command completes
				const result = await pi.exec(
					"tmux",
					["new-window", "-n", name, "-d", "-P", "-F", "#{window_id}", command],
					{ signal },
				);

				if (result.code !== 0) {
					return {
						content: [{ type: "text", text: `Error creating tmux window: ${result.stderr || result.stdout}` }],
						details: { error: "create_failed", stderr: result.stderr, stdout: result.stdout },
						isError: true,
					};
				}

				// Set remain-on-exit for this window so it stays open after command finishes
				const windowId = result.stdout.trim();
				await pi.exec("tmux", ["set-option", "-t", windowId, "remain-on-exit", "on"], { signal });

				activeWindows.set(name, { created: Date.now() });

				return {
					content: [
						{
							type: "text",
							text: `Created tmux window '${name}' and started command: ${command}\n\nUse tmux-capture to see output, tmux-send to interact, or tmux-kill to close.`,
						},
					],
					details: { name, command, created: Date.now() },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
					details: { error: "exception" },
					isError: true,
				};
			}
		},
	});

	// tmux-capture: Capture pane output
	pi.registerTool({
		name: "tmux-capture",
		label: "Tmux Capture",
		description: "Capture the current output from a tmux window pane. Returns the visible content and scrollback.",
		parameters: tmuxCaptureParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!isTmuxAvailable()) {
				return {
					content: [{ type: "text", text: "Error: Not running inside a tmux session." }],
					details: { error: "no_tmux" },
					isError: true,
				};
			}

			const { name, lines = 500 } = params;

			try {
				// First check if window exists
				const checkResult = await pi.exec("tmux", ["list-windows", "-F", "#{window_name}"], { signal });
				const windowNames = checkResult.stdout.split("\n").filter(Boolean);

				if (!windowNames.includes(name)) {
					// Clean up tracking if window doesn't exist
					activeWindows.delete(name);
					return {
						content: [
							{
								type: "text",
								text: `Error: Window '${name}' not found. Available windows: ${windowNames.join(", ") || "(none)"}`,
							},
						],
						details: { error: "window_not_found", available: windowNames },
						isError: true,
					};
				}

				// Capture pane output
				const result = await pi.exec("tmux", ["capture-pane", "-t", name, "-p", "-S", `-${lines}`], { signal });

				if (result.code !== 0) {
					return {
						content: [{ type: "text", text: `Error capturing pane: ${result.stderr}` }],
						details: { error: "capture_failed", stderr: result.stderr },
						isError: true,
					};
				}

				let output = result.stdout;

				// Apply truncation
				const truncation = truncateTail(output, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				output = truncation.content;

				if (truncation.truncated) {
					output += `\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines`;
					output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
				}

				// Update tracking
				if (!activeWindows.has(name)) {
					activeWindows.set(name, { created: Date.now() });
				}

				return {
					content: [{ type: "text", text: output || "(empty output)" }],
					details: { name, lines: truncation.outputLines, truncated: truncation.truncated },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
					details: { error: "exception" },
					isError: true,
				};
			}
		},
	});

	// tmux-send: Send keys to window
	pi.registerTool({
		name: "tmux-send",
		label: "Tmux Send",
		description:
			"Send text or keys to a tmux window. Use to interact with running processes. Special keys: Enter, Escape, C-c (Ctrl+C), C-d (Ctrl+D), etc.",
		parameters: tmuxSendParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!isTmuxAvailable()) {
				return {
					content: [{ type: "text", text: "Error: Not running inside a tmux session." }],
					details: { error: "no_tmux" },
					isError: true,
				};
			}

			const { name, text, enter = true } = params;

			try {
				// Check if window exists
				const checkResult = await pi.exec("tmux", ["list-windows", "-F", "#{window_name}"], { signal });
				const windowNames = checkResult.stdout.split("\n").filter(Boolean);

				if (!windowNames.includes(name)) {
					activeWindows.delete(name);
					return {
						content: [{ type: "text", text: `Error: Window '${name}' not found.` }],
						details: { error: "window_not_found" },
						isError: true,
					};
				}

				// Build tmux send-keys command
				const args = ["send-keys", "-t", name, text];
				if (enter) {
					args.push("Enter");
				}

				const result = await pi.exec("tmux", args, { signal });

				if (result.code !== 0) {
					return {
						content: [{ type: "text", text: `Error sending keys: ${result.stderr}` }],
						details: { error: "send_failed", stderr: result.stderr },
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Sent to '${name}': ${text}${enter ? " [Enter]" : ""}\n\nUse tmux-capture to see the result.`,
						},
					],
					details: { name, text, enter },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
					details: { error: "exception" },
					isError: true,
				};
			}
		},
	});

	// tmux-kill: Kill a window
	pi.registerTool({
		name: "tmux-kill",
		label: "Tmux Kill",
		description: "Kill a tmux window and its running process.",
		parameters: tmuxKillParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!isTmuxAvailable()) {
				return {
					content: [{ type: "text", text: "Error: Not running inside a tmux session." }],
					details: { error: "no_tmux" },
					isError: true,
				};
			}

			const { name } = params;

			try {
				// Check if window exists first
				const checkResult = await pi.exec("tmux", ["list-windows", "-F", "#{window_name}"], { signal });
				const windowNames = checkResult.stdout.split("\n").filter(Boolean);

				if (!windowNames.includes(name)) {
					activeWindows.delete(name);
					return {
						content: [{ type: "text", text: `Window '${name}' not found (may have already exited).` }],
						details: { name, existed: false },
					};
				}

				const result = await pi.exec("tmux", ["kill-window", "-t", name], { signal });

				activeWindows.delete(name);

				if (result.code !== 0) {
					return {
						content: [{ type: "text", text: `Error killing window: ${result.stderr}` }],
						details: { error: "kill_failed", stderr: result.stderr },
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: `Killed tmux window '${name}'.` }],
					details: { name, killed: true },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
					details: { error: "exception" },
					isError: true,
				};
			}
		},
	});

	// Command to list active windows
	pi.registerCommand("tmux-list", {
		description: "List active tmux windows",
		handler: async (_args, ctx) => {
			if (!isTmuxAvailable()) {
				ctx.ui.notify("Not running inside tmux session", "error");
				return;
			}

			const result = await pi.exec("tmux", ["list-windows", "-F", "#{window_name}: #{window_active}"]);
			const windows = result.stdout.trim() || "(no windows)";
			ctx.ui.notify(`Tmux windows:\n${windows}`, "info");
		},
	});

	// Clean up tracking on shutdown
	pi.on("session_shutdown", async () => {
		activeWindows.clear();
	});
}
