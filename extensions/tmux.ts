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
import {
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
  createLock,
  releaseLock,
  sanitizeName,
} from "pi-semaphore/extensions/semaphore-locks.js";

// Track active windows and their locks
const activeWindows = new Map<
  string,
  { created: number; lockName: string | null; isCodingAgent: boolean }
>();

// Track the last input text we warned about per window.
// If tmux-send detects text in a coding agent's input box, it stores the text here
// and returns a warning. On the next send attempt, if the text is unchanged, the
// warning is cleared and the send proceeds (the human stopped typing). If the text
// changed, the warning fires again with the new text.
const lastWarnedInput = new Map<string, string>();

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
  /** The actual window name used (may differ from requested if deduplicated). */
  name: string;
  lockName: string | null;
}

/**
 * Find a unique tmux window name by appending -2, -3, etc. if the base name
 * is already used by an existing tmux window or tracked in activeWindows.
 */
async function findUniqueWindowName(
  pi: ExtensionAPI,
  baseName: string,
  signal?: AbortSignal,
): Promise<string> {
  // Get existing tmux window names
  const result = await pi.exec(
    "tmux",
    ["list-windows", "-F", "#{window_name}"],
    { signal },
  );
  const existingNames = new Set(
    result.code === 0
      ? result.stdout.split("\n").filter(Boolean)
      : [],
  );
  // Also include names we're tracking locally (in case tmux list-windows lags)
  for (const name of activeWindows.keys()) {
    existingNames.add(name);
  }

  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let n = 2;
  while (n < 1000) {
    const candidate = `${baseName}-${n}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
    n++;
  }
  // Fallback: use PID + timestamp
  return `${baseName}-${process.pid}`;
}

/**
 * Create a tmux window running bash with a semaphore lock and remain-on-exit.
 * Uses tmux -e for env and -- bash -c to bypass the default shell.
 * If a window with the requested name already exists, appends -2, -3, etc.
 * Throws on failure (cleans up lock automatically).
 */
async function createWindow(
  pi: ExtensionAPI,
  opts: CreateWindowOptions,
): Promise<CreateWindowResult> {
  const { name: requestedName, command, cwd, signal, skipTmuxLock } = opts;

  if (!isTmuxAvailable()) {
    throw new TmuxError(
      "Not running inside a tmux session. TMUX env variable not set.",
      "no_tmux",
    );
  }

  const name = await findUniqueWindowName(pi, requestedName, signal);

  let lockName: string | null = null;
  if (!skipTmuxLock) {
    const lockResult = await createLock(getTmuxLockName(name));
    lockName = lockResult?.name ?? null;
  }

  // Wrap command to release the lock when it finishes (regardless of exit code)
  const lockCleanup = lockName ? `; rm -f '/tmp/pi-locks/${lockName}'` : "";
  const wrappedCommand = `${command}${lockCleanup}`;

  const args = [
    "new-window",
    "-n",
    name,
    "-d",
    "-P",
    "-F",
    "#{window_id}",
    "-e",
    `PI_LOCK_NAME=${sanitizeName(name)}`,
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
  await pi.exec(
    "tmux",
    ["set-option", "-t", windowId, "remain-on-exit", "on"],
    { signal },
  );
  activeWindows.set(name, { created: Date.now(), lockName, isCodingAgent: false });

  return { name, lockName };
}

/**
 * Strip the pi startup help block and [Extensions] block from captured output.
 * Removes everything from the "pi v<version>" line through the next empty line
 * (keeps the version line itself, drops the keybinding hints).
 * Also removes the [Extensions] block entirely.
 */
function stripStartupHelp(output: string): string {
  const lines = output.split("\n");

  // Strip controls block after "pi v<version>"
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*pi v\d+\.\d+\.\d+/.test(lines[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx !== -1) {
    // Find the next empty line after the version line
    let endIdx = startIdx + 1;
    while (endIdx < lines.length && lines[endIdx].trim() !== "") {
      endIdx++;
    }
    // Remove from startIdx+1 (keep the version line) through endIdx (inclusive, the blank line)
    lines.splice(startIdx + 1, endIdx - startIdx);
  }

  // Strip [Extensions] block: from the [Extensions] line through the next empty line
  let extIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[Extensions\]/.test(lines[i])) {
      extIdx = i;
      break;
    }
  }
  if (extIdx !== -1) {
    let endIdx = extIdx + 1;
    while (endIdx < lines.length && lines[endIdx].trim() !== "") {
      endIdx++;
    }
    // Remove from extIdx through endIdx (inclusive, the trailing blank line)
    lines.splice(extIdx, endIdx - extIdx + 1);
  }

  return lines.join("\n");
}

/**
 * Detect text in a pi coding agent's input box from captured tmux output.
 *
 * The pi TUI renders the input area between two horizontal separator lines
 * (made of ─ characters), followed by the footer (pwd, stats, model info).
 * When the input is empty, there's nothing (or just whitespace) between
 * the two separators. When a human is typing, their text appears there.
 *
 * Returns the detected input text, or null if the input box is empty or
 * the pi input layout wasn't found.
 */
function detectPiInputText(capturedOutput: string): string | null {
  const lines = capturedOutput.split("\n");

  // Find separator lines (lines consisting entirely of ─ characters, at least 10 wide).
  // We want the LAST pair of consecutive separators (the input box is at the bottom,
  // right above the footer).
  const separatorIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length >= 10 && /^[─]+$/.test(trimmed)) {
      separatorIndices.push(i);
    }
  }

  // Need at least two separators to form an input box
  if (separatorIndices.length < 2) {
    return null;
  }

  // Take the last two separators
  const topSep = separatorIndices[separatorIndices.length - 2];
  const bottomSep = separatorIndices[separatorIndices.length - 1];

  // Extract lines between the two separators
  const betweenLines = lines.slice(topSep + 1, bottomSep);
  const inputText = betweenLines
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()) // strip ANSI codes
    .filter((l) => l.length > 0 && l !== ">") // ignore empty lines and bare prompt
    .join("\n");

  // The pi input prompt is "> " - strip it if present
  const cleaned = inputText.replace(/^>\s?/, "").trim();

  return cleaned.length > 0 ? cleaned : null;
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
    content: [
      {
        type: "text" as const,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    details: { error: "exception" },
    isError: true as const,
  };
}

// tmux-bash parameters
const tmuxBashParams = Type.Object({
  name: Type.String({
    description: "Name for the tmux window (used to identify it later)",
  }),
  command: Type.String({
    description: "Command to execute in the tmux window",
  }),
});
export type TmuxBashInput = Static<typeof tmuxBashParams>;

// tmux-capture parameters
const tmuxCaptureParams = Type.Object({
  name: Type.String({
    description: "Name of the tmux window to capture output from",
  }),
  lines: Type.Optional(
    Type.Number({ description: "Number of lines to capture (default: 500)" }),
  ),
});
export type TmuxCaptureInput = Static<typeof tmuxCaptureParams>;

// tmux-send parameters
const tmuxSendParams = Type.Object({
  name: Type.String({ description: "Name of the tmux window to send to" }),
  text: Type.String({
    description:
      "Text or keys to send (e.g., 'ls -la', 'Enter', 'C-c' for Ctrl+C)",
  }),
  enter: Type.Optional(
    Type.Boolean({
      description: "Whether to press Enter after sending text (default: true)",
    }),
  ),
});
export type TmuxSendInput = Static<typeof tmuxSendParams>;

// tmux-kill parameters
const tmuxKillParams = Type.Object({
  name: Type.String({ description: "Name of the tmux window to kill" }),
});
export type TmuxKillInput = Static<typeof tmuxKillParams>;

// tmux-coding-agent parameters
const tmuxCodingAgentParams = Type.Object({
  name: Type.String({
    description:
      "Name for the tmux window and lock (e.g., 'worker', 'reviewer')",
  }),
  folder: Type.String({
    description: "Working directory for the pi instance (e.g., '../hppr')",
  }),
  piArgs: Type.Optional(
    Type.String({
      description:
        "Additional pi CLI arguments. To launch a codex agent, use '--provider openai-codex --model gpt-5.3-codex'. For thinking mode, use '--thinking high'.",
    }),
  ),
});
export type TmuxCodingAgentInput = Static<typeof tmuxCodingAgentParams>;

export default function (pi: ExtensionAPI) {
  // Check tmux availability on session start
  pi.on("session_start", async (_event, ctx) => {
    if (!isTmuxAvailable()) {
      ctx.ui.notify(
        "tmux extension: Not running in tmux session (TMUX env not set)",
        "warning",
      );
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
      const { name: requestedName, command } = params;
      try {
        const { name: actualName, lockName } = await createWindow(pi, {
          name: requestedName,
          command: command || "exec bash",
          signal,
        });
        const lockInfo = lockName ? ` Lock '${lockName}' created.` : "";
        const renameInfo = actualName !== requestedName ? ` (renamed from '${requestedName}' to avoid conflict)` : "";
        return {
          content: [
            {
              type: "text",
              text: `Created tmux window '${actualName}'${renameInfo} running: ${command || "bash"}${lockInfo}\n\nUse tmux-capture to see output, tmux-send to interact, or tmux-kill to close.`,
            },
          ],
          details: {
            name: actualName,
            requestedName,
            command: command || "bash",
            created: Date.now(),
            lock: lockName,
          },
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
    description:
      "Capture the current output from a tmux window pane. Returns the visible content and scrollback.",
    parameters: tmuxCaptureParams,

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (!isTmuxAvailable()) {
        return {
          content: [
            { type: "text", text: "Error: Not running inside a tmux session." },
          ],
          details: { error: "no_tmux" },
          isError: true,
        };
      }

      const { name, lines = 500 } = params;

      try {
        // First check if window exists
        const checkResult = await pi.exec(
          "tmux",
          ["list-windows", "-F", "#{window_name}"],
          { signal },
        );
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
        const result = await pi.exec(
          "tmux",
          ["capture-pane", "-t", `${name}.0`, "-p", "-S", `-${lines}`],
          { signal },
        );

        if (result.code !== 0) {
          return {
            content: [
              { type: "text", text: `Error capturing pane: ${result.stderr}` },
            ],
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
          activeWindows.set(name, { created: Date.now(), lockName: null, isCodingAgent: false });
        }

        return {
          content: [{ type: "text", text: output || "(empty output)" }],
          details: {
            name,
            lines: truncation.outputLines,
            truncated: truncation.truncated,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
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
          content: [
            { type: "text", text: "Error: Not running inside a tmux session." },
          ],
          details: { error: "no_tmux" },
          isError: true,
        };
      }

      const { name, text, enter = true } = params;

      try {
        // Check if window exists
        const checkResult = await pi.exec(
          "tmux",
          ["list-windows", "-F", "#{window_name}"],
          { signal },
        );
        const windowNames = checkResult.stdout.split("\n").filter(Boolean);

        if (!windowNames.includes(name)) {
          activeWindows.delete(name);
          return {
            content: [
              { type: "text", text: `Error: Window '${name}' not found.` },
            ],
            details: { error: "window_not_found" },
            isError: true,
          };
        }

        // If this is a coding agent window, check for human input before sending.
        // Only check when we're about to submit (enter=true) — if we're just
        // sending text without Enter, there's no risk of clobbering.
        const windowInfo = activeWindows.get(name);
        if (windowInfo?.isCodingAgent && enter) {
          const capResult = await pi.exec(
            "tmux",
            ["capture-pane", "-t", `${name}.0`, "-p", "-S", "-50"],
            { signal },
          );
          if (capResult.code === 0) {
            const existingInput = detectPiInputText(capResult.stdout);
            if (existingInput !== null) {
              const previouslyWarned = lastWarnedInput.get(name);
              if (previouslyWarned === existingInput) {
                // Same text as last warning — human stopped typing, allow the send.
                lastWarnedInput.delete(name);
              } else {
                // New or changed text — warn and record it.
                lastWarnedInput.set(name, existingInput);
                return {
                  content: [
                    {
                      type: "text",
                      text:
                        `Warning: The pi input box in window '${name}' already contains text:\n\n` +
                        `  "${existingInput}"\n\n` +
                        `A human may be typing. The send was NOT executed.\n` +
                        `You may retry the tmux-send if this was text you placed.`,
                    },
                  ],
                  details: {
                    error: "human_typing_detected",
                    name,
                    existingInput,
                    intendedText: text,
                  },
                  isError: true,
                };
              }
            } else {
              // Input is empty — clear any stale warning state.
              lastWarnedInput.delete(name);
            }
          }
        }

        // Build tmux send-keys command
        const args = ["send-keys", "-t", name, text];
        if (enter) {
          args.push("Enter");
        }

        const result = await pi.exec("tmux", args, { signal });

        if (result.code !== 0) {
          return {
            content: [
              { type: "text", text: `Error sending keys: ${result.stderr}` },
            ],
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
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
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
          content: [
            { type: "text", text: "Error: Not running inside a tmux session." },
          ],
          details: { error: "no_tmux" },
          isError: true,
        };
      }

      const { name } = params;

      try {
        // Check if window exists first
        const checkResult = await pi.exec(
          "tmux",
          ["list-windows", "-F", "#{window_name}"],
          { signal },
        );
        const windowNames = checkResult.stdout.split("\n").filter(Boolean);

        if (!windowNames.includes(name)) {
          // Release lock if we were tracking this window
          const windowInfo = activeWindows.get(name);
          if (windowInfo?.lockName) {
            await releaseLock(windowInfo.lockName);
          }
          activeWindows.delete(name);
          lastWarnedInput.delete(name);
          return {
            content: [
              {
                type: "text",
                text: `Window '${name}' not found (may have already exited).`,
              },
            ],
            details: { name, existed: false },
          };
        }

        const result = await pi.exec("tmux", ["kill-window", "-t", name], {
          signal,
        });

        // Clean up warning state
        lastWarnedInput.delete(name);

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
            content: [
              { type: "text", text: `Error killing window: ${result.stderr}` },
            ],
            details: { error: "kill_failed", stderr: result.stderr },
            isError: true,
          };
        }

        const lockInfo =
          lockReleased && releasedLockName
            ? ` Lock '${releasedLockName}' released.`
            : "";
        return {
          content: [
            { type: "text", text: `Killed tmux window '${name}'.${lockInfo}` },
          ],
          details: {
            name,
            killed: true,
            lockReleased,
            lockName: releasedLockName,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
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
      const { name: requestedName, folder, piArgs } = params;
      const piParts = ["pi"];
      if (piArgs) piParts.push(piArgs);
      const piCommand = piParts.join(" ");

      try {
        const { name: actualName, lockName } = await createWindow(pi, {
          name: requestedName,
          command: piCommand,
          cwd: folder,
          signal,
          skipTmuxLock: true,
        });

        // Mark this window as a coding agent for human-typing detection
        const windowInfo = activeWindows.get(actualName);
        if (windowInfo) {
          windowInfo.isCodingAgent = true;
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Window '${actualName}' created. Waiting for pi to start...`,
            },
          ],
          details: { waiting: true, name: actualName },
        });

        // Wait for startup: >10 non-empty lines or 5 seconds, whichever comes first
        const startTime = Date.now();
        const maxWait = 5000;
        const pollMs = 300;
        let capturedOutput = "";

        while (Date.now() - startTime < maxWait) {
          if (signal?.aborted) break;

          const cap = await pi.exec(
            "tmux",
            ["capture-pane", "-t", `${actualName}.0`, "-p", "-S", "-500"],
            { signal },
          );
          if (cap.code === 0) {
            const trimmed = cap.stdout.replace(/\n+$/, "");
            const lineCount = trimmed
              .split("\n")
              .filter((l) => l.trim().length > 0).length;
            if (lineCount > 10) {
              capturedOutput = trimmed;
              break;
            }
            capturedOutput = trimmed;
          }

          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        // One final capture if we timed out
        if (
          !capturedOutput ||
          capturedOutput.split("\n").filter((l) => l.trim().length > 0)
            .length <= 10
        ) {
          const cap = await pi.exec(
            "tmux",
            ["capture-pane", "-t", `${actualName}.0`, "-p", "-S", "-500"],
            { signal },
          );
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

        const agentLockName = sanitizeName(actualName);
        const renameInfo = actualName !== requestedName ? ` (renamed from '${requestedName}' to avoid conflict)` : "";
        return {
          content: [
            {
              type: "text",
              text: `Pi agent '${actualName}'${renameInfo} started in ${folder}.\n\nStartup output:\n${output || "(empty)"}\n\nUse tmux-send to send tasks, semaphore_wait('${agentLockName}') to wait for completion.`,
            },
          ],
          details: {
            name: actualName,
            requestedName,
            folder,
            piCommand,
            agentLock: agentLockName,
            created: Date.now(),
          },
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

      const result = await pi.exec("tmux", [
        "list-windows",
        "-F",
        "#{window_name}: #{window_active}",
      ]);
      const windows = result.stdout.trim() || "(no windows)";
      ctx.ui.notify(`Tmux windows:\n${windows}`, "info");
    },
  });

  // Clean up tracking on shutdown
  pi.on("session_shutdown", async () => {
    activeWindows.clear();
    lastWarnedInput.clear();
  });
}
