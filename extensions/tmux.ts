/**
 * Tmux Extension (script-backed)
 *
 * Delegates tmux operations to ../bin/pi-tmux.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const TMUX_SCRIPT = path.resolve(__dirname, "../bin/pi-tmux");

function isTmuxAvailable(): boolean {
  return !!process.env.TMUX;
}

async function runTmux(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return pi.exec("bash", [TMUX_SCRIPT, ...args], { signal });
}

function outputText(stdout: string, stderr: string): string {
  const text = stdout.trim() || stderr.trim();
  return text.length > 0 ? text : "(no output)";
}

const tmuxBashParams = Type.Object({
  name: Type.String({
    description: "Lock name for the spawned tmux pane",
  }),
  command: Type.String({
    description: "Command to execute in the tmux pane",
  }),
});
export type TmuxBashInput = Static<typeof tmuxBashParams>;

const tmuxCaptureParams = Type.Object({
  name: Type.String({
    description: "Lock name or pane id (e.g., worker or %12)",
  }),
  lines: Type.Optional(
    Type.Number({ description: "Number of lines to capture (default: 500)" }),
  ),
});
export type TmuxCaptureInput = Static<typeof tmuxCaptureParams>;

const tmuxSendParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id" }),
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

const tmuxKillParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id" }),
});
export type TmuxKillInput = Static<typeof tmuxKillParams>;

const tmuxCodingAgentParams = Type.Object({
  name: Type.String({
    description: "Lock name for the coding agent",
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
  pi.on("session_start", async (_event, ctx) => {
    if (!isTmuxAvailable()) {
      ctx.ui.notify(
        "tmux extension: Not running in tmux session (TMUX env not set)",
        "warning",
      );
    }
  });

  pi.registerTool({
    name: "tmux-bash",
    label: "Tmux Bash",
    description:
      "Create a new tmux pane with the given lock name and execute a command. Use ONLY for long-running processes (servers, watch commands, builds >30s).",
    parameters: tmuxBashParams,
    async execute(_toolCallId, params, signal) {
      const args = params.command
        ? ["bash", params.name, params.command]
        : ["bash", params.name];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        return {
          content: [{ type: "text", text: text }],
          details: { code: result.code, args },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-capture",
    label: "Tmux Capture",
    description:
      "Capture output from a tmux pane by lock name or pane id.",
    parameters: tmuxCaptureParams,
    async execute(_toolCallId, params, signal) {
      const args = ["capture", params.name, String(params.lines ?? 500)];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        return {
          content: [{ type: "text", text }],
          details: { code: result.code, args },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-send",
    label: "Tmux Send",
    description:
      "Send text or keys to a tmux pane by lock name or pane id.",
    parameters: tmuxSendParams,
    async execute(_toolCallId, params, signal) {
      const args = [
        "send",
        params.name,
        ...(params.enter === false ? ["--no-enter"] : []),
        params.text,
      ];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        return {
          content: [{ type: "text", text }],
          details: { code: result.code, args },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-kill",
    label: "Tmux Kill",
    description: "Kill a tmux pane by lock name or pane id.",
    parameters: tmuxKillParams,
    async execute(_toolCallId, params, signal) {
      const args = ["kill", params.name];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        return {
          content: [{ type: "text", text }],
          details: { code: result.code, args },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-coding-agent",
    label: "Tmux Coding Agent",
    description:
      "Spawn a pi coding agent in a tmux pane using the given lock name and folder.",
    parameters: tmuxCodingAgentParams,
    async execute(_toolCallId, params, signal) {
      const args = ["coding-agent", params.name, params.folder];
      if (params.piArgs) {
        args.push(params.piArgs);
      }

      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        return {
          content: [{ type: "text", text }],
          details: { code: result.code, args },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerCommand("tmux-list", {
    description: "List active tmux panes",
    handler: async (_args, ctx) => {
      const result = await runTmux(pi, ["list"]);
      const text = outputText(result.stdout, result.stderr);
      ctx.ui.notify(text, result.code === 0 ? "info" : "error");
    },
  });
}
