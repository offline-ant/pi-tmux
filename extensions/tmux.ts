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
 *   tmux-coding-agent - Spawn a pi coding agent in a tmux window and wait for startup
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
import { createLock, releaseLock, sanitizeName } from "pi-semaphore/extensions/semaphore-locks.js";

// Track active windows and their locks
const activeWindows = new Map<string, { created: number; lockName: string | null }>();

function getTmuxLockName(windowName: string): string {
	return `tmux:${sanitizeName(windowName)}`;
}

function isTmuxAvailable(): boolean {
	return !!process.env.TMUX;
}

interface CreateWindowOptions {
	name: string;
	command: string;
	cwd?: string;
	signal?: AbortSignal;
	/** Skip creating the tmux:<name> lock. Used for coding agents that create their own pi semaphore lock. */
	skipTmuxLock?: boolean;
}

interface CreateWindowResult {
	lockName: string | null;
}

/**
 * Create a tmux window running bash with a semaphore lock and remain-on-exit.
 * Uses tmux -e for env and -- bash -c to bypass the default shell.
 * Throws on failure (cleans up lock automatically).
 */
async function createWindow(pi: ExtensionAPI, opts: CreateWindowOptions): Promise<CreateWindowResult> {
	const { name, command, cwd, signal, skipTmuxLock } = opts;

	if (!isTmuxAvailable()) {
		throw new TmuxError("Not running inside a tmux session. TMUX env variable not set.", "no_tmux");
	}

	if (activeWindows.has(name)) {
		throw new TmuxError(
			`Window '${name}' already exists. Use tmux-send to send commands, tmux-capture to get output, or tmux-kill to close it first.`,
			"window_exists",
		);
	}

	let lockName: string | null = null;
	if (!skipTmuxLock) {
		const lockResult = await createLock(getTmuxLockName(name));
		lockName = lockResult?.name ?? null;
	}

	// Wrap command to release the lock when it finishes (regardless of exit code)
	const lockCleanup = lockName ? `; rm -f '/tmp/pi-locks/${lockName}'` : "";
	const wrappedCommand = `${command}${lockCleanup}`;

	const args = [
		"new-window", "-n", name, "-d", "-P", "-F", "#{window_id}",
		"-e", `PI_LOCK_NAME=${sanitizeName(name)}`,
	];
	if (cwd) {
		args.push("-c", cwd);
	}
	args.push("--", "bash", "-c", wrappedCommand);

	const result = await pi.exec("tmux", args, { signal });

	if (result.code !== 0) {
		if (lockName) await releaseLock(lockName);
		throw new TmuxError(
			`Error creating tmux window: ${result.stderr || result.stdout}`,
			"create_failed",
		);
	}

	const windowId = result.stdout.trim();
	await pi.exec("tmux", ["set-option", "-t", windowId, "remain-on-exit", "on"], { signal });
	activeWindows.set(name, { created: Date.now(), lockName });

	return { lockName };
}

/**
 * Strip the pi startup help block from captured output.
 * Removes everything from the "pi v<version>" line through the next empty line.
 * Keeps the version line itself (just the first line), drops the keybinding hints.
 */
function stripStartupHelp(output: string): string {
	const lines = output.split("\n");
	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*pi v\d+\.\d+\.\d+/.test(lines[i])) {
			startIdx = i;
			break;
		}
	}
	if (startIdx === -1) return output;

	// Find the next empty line after the version line
	let endIdx = startIdx + 1;
	while (endIdx < lines.length && lines[endIdx].trim() !== "") {
		endIdx++;
	}
	// endIdx now points at the empty line (or end of array)
	// Remove from startIdx+1 (keep the version line) through endIdx (inclusive, the blank line)
	lines.splice(startIdx + 1, endIdx - startIdx);
	return lines.join("\n");
}

class TmuxError extends Error {
	code: string;
	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}

function tmuxErrorResult(error: unknown) {
	if (error instanceof TmuxError) {
		return {
			content: [{ type: "text" as const, text: `Error: ${error.message}` }],
			details: { error: error.code },
			isError: true as const,
		};
	}
	return {
		content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
		details: { error: "exception" },
		isError: true as const,
	};
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

// tmux-coding-agent parameters
const tmuxCodingAgentParams = Type.Object({
	name: Type.String({ description: "Name for the tmux window and lock (e.g., 'worker', 'reviewer')" }),
	folder: Type.String({ description: "Working directory for the pi instance (e.g., '../hppr')" }),
	piArgs: Type.Optional(Type.String({ description: "Additional pi CLI arguments. To launch a codex agent, use '--provider openai-codex --model gpt-5.2-codex'. For thinking mode, use '--thinking high'." })),
});
export type TmuxCodingAgentInput = Static<typeof tmuxCodingAgentParams>;

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
			"Create a new tmux window with the given name and execute a command. Use ONLY for long-running processes (servers, watch commands, builds >30s). For quick commands that complete fast, use the regular 'bash' tool instead. The window stays open after the command completes so you can capture output. Requires running inside tmux.",
		parameters: tmuxBashParams,

		async execute(_toolCallId, params, signal) {
			const { name, command } = params;
			try {
				const { lockName } = await createWindow(pi, { name, command: command || "exec bash", signal });
				const lockInfo = lockName ? ` Lock '${lockName}' created.` : "";
				return {
					content: [
						{
							type: "text",
							text: `Created tmux window '${name}' running: ${command || "bash"}${lockInfo}\n\nUse tmux-capture to see output, tmux-send to interact, or tmux-kill to close.`,
						},
					],
					details: { name, command: command || "bash", created: Date.now(), lock: lockName },
				};
			} catch (error) {
				return tmuxErrorResult(error);
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

				// Strip trailing empty lines
				let output = result.stdout.replace(/\n+$/, "");

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
					activeWindows.set(name, { created: Date.now(), lockName: null });
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
					// Release lock if we were tracking this window
					const windowInfo = activeWindows.get(name);
					if (windowInfo?.lockName) {
						await releaseLock(windowInfo.lockName);
					}
					activeWindows.delete(name);
					return {
						content: [{ type: "text", text: `Window '${name}' not found (may have already exited).` }],
						details: { name, existed: false },
					};
				}

				const result = await pi.exec("tmux", ["kill-window", "-t", name], { signal });

				// Release lock for this window
				const windowInfo = activeWindows.get(name);
				let lockReleased = false;
				let releasedLockName: string | null = null;
				if (windowInfo?.lockName) {
					lockReleased = await releaseLock(windowInfo.lockName);
					releasedLockName = windowInfo.lockName;
				}
				activeWindows.delete(name);

				if (result.code !== 0) {
					return {
						content: [{ type: "text", text: `Error killing window: ${result.stderr}` }],
						details: { error: "kill_failed", stderr: result.stderr },
						isError: true,
					};
				}

				const lockInfo = lockReleased && releasedLockName ? ` Lock '${releasedLockName}' released.` : "";
				return {
					content: [{ type: "text", text: `Killed tmux window '${name}'.${lockInfo}` }],
					details: { name, killed: true, lockReleased, lockName: releasedLockName },
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

	// tmux-coding-agent: Spawn a pi instance in a tmux window, wait for startup, return initial output
	pi.registerTool({
		name: "tmux-coding-agent",
		label: "Tmux Coding Agent",
		description:
			"Spawn a pi coding agent in a new tmux window. Creates the window, launches pi in the given folder, " +
			"waits for startup (until >10 lines of output appear or 5 seconds pass), and returns the captured output. " +
			"The spawned pi agent creates its own semaphore lock using the window name (e.g., name='worker' → lock 'worker'). " +
			"After startup, use tmux-send to send tasks and semaphore_wait with the window name to wait for the agent to finish. " +
			"Note: semaphore_wait blocks all progress until the lock is released — finish any independent work before calling it.",
		parameters: tmuxCodingAgentParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			const { name, folder, piArgs } = params;
			const piParts = ["pi"];
			if (piArgs) piParts.push(piArgs);
			const piCommand = piParts.join(" ");

			try {
				const { lockName } = await createWindow(pi, { name, command: piCommand, cwd: folder, signal, skipTmuxLock: true });

				onUpdate?.({
					content: [{ type: "text", text: `Window '${name}' created. Waiting for pi to start...` }],
					details: { waiting: true, name },
				});

				// Wait for startup: >10 non-empty lines or 5 seconds, whichever comes first
				const startTime = Date.now();
				const maxWait = 5000;
				const pollMs = 300;
				let capturedOutput = "";

				while (Date.now() - startTime < maxWait) {
					if (signal?.aborted) break;

					const cap = await pi.exec("tmux", ["capture-pane", "-t", name, "-p", "-S", "-500"], { signal });
					if (cap.code === 0) {
						const trimmed = cap.stdout.replace(/\n+$/, "");
						const lineCount = trimmed.split("\n").filter((l) => l.trim().length > 0).length;
						if (lineCount > 10) {
							capturedOutput = trimmed;
							break;
						}
						capturedOutput = trimmed;
					}

					await new Promise((resolve) => setTimeout(resolve, pollMs));
				}

				// One final capture if we timed out
				if (!capturedOutput || capturedOutput.split("\n").filter((l) => l.trim().length > 0).length <= 10) {
					const cap = await pi.exec("tmux", ["capture-pane", "-t", name, "-p", "-S", "-500"], { signal });
					if (cap.code === 0) {
						capturedOutput = cap.stdout.replace(/\n+$/, "");
					}
				}

				// Strip the keybinding help block from startup output
				capturedOutput = stripStartupHelp(capturedOutput);

				// Apply truncation
				const truncation = truncateTail(capturedOutput, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				let output = truncation.content;
				if (truncation.truncated) {
					output += `\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines`;
					output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
				}

				const agentLockName = sanitizeName(name);
				return {
					content: [
						{
							type: "text",
							text: `Pi agent '${name}' started in ${folder}.\n\nStartup output:\n${output || "(empty)"}\n\nUse tmux-send to send tasks, semaphore_wait('${agentLockName}') to wait for completion.`,
						},
					],
					details: { name, folder, piCommand, agentLock: agentLockName, created: Date.now() },
				};
			} catch (error) {
				return tmuxErrorResult(error);
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
