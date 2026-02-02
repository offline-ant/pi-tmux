# pi-tmux

Tmux tools for [pi](https://github.com/badlogic/pi-mono) - run long-running commands in tmux windows.

## Requirements

- Must be running inside a tmux session (`TMUX` env var set)
- tmux must be installed

## Installation

```bash
pi install git:github.com/offline-ant/pi-tmux
```

Or try without installing:

```bash
pi -e git:github.com/offline-ant/pi-tmux
```

## Tools

| Tool | Description |
|------|-------------|
| `tmux-bash` | Create a new tmux window and execute a command |
| `tmux-capture` | Capture output from a tmux window pane |
| `tmux-send` | Send text or keys to a tmux window |
| `tmux-kill` | Kill a tmux window and its running process |

## Example

The LLM can use these tools to manage long-running processes:

1. Start a dev server: `tmux-bash` with name "dev" and command "npm run dev"
2. Check output: `tmux-capture` with name "dev"
3. Stop the server: `tmux-send` with name "dev" and text "C-c" (Ctrl+C)
4. Clean up: `tmux-kill` with name "dev"

## Commands

The extension also registers a `/tmux-list` command to list active tmux windows.

## License

MIT
