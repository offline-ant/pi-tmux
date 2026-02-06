# pi-tmux

Tmux tools for [pi](https://github.com/badlogic/pi-mono) - run long-running commands in tmux windows.

## Requirements

- Must be running inside a tmux session (`TMUX` env var set)
- tmux must be installed
- [pi-semaphore](https://github.com/offline-ant/pi-semaphore) (installed as dependency)

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
| `tmux-bash` | Create a new tmux window and execute a command (defaults to `bash`) |
| `tmux-capture` | Capture output from a tmux window pane |
| `tmux-send` | Send text or keys to a tmux window |
| `tmux-kill` | Kill a tmux window and its running process |
| `tmux-coding-agent` | Spawn a pi coding agent in a tmux window, wait for startup, return initial output |

## Semaphore Integration

When `tmux-bash` creates a window:

1. **Sets `PI_LOCK_NAME`** - The window name is passed to spawned processes via the `PI_LOCK_NAME` environment variable. If you spawn a pi instance in the window, it will use the window name as its lock name instead of the directory basename.

2. **Creates a `tmux:<name>` lock** - A semaphore lock is created for the tmux window itself. This lock is released when the command exits or `tmux-kill` is called. If a lock with the same name already exists, a suffix is appended (`tmux:worker-2`, etc.).

When `tmux-coding-agent` creates a window:

1. **Sets `PI_LOCK_NAME`** - Same as above.
2. **No `tmux:` lock** - The spawned pi agent creates its own semaphore lock (e.g., name `worker` → lock `worker`). There is no additional `tmux:worker` lock. This avoids confusion about which lock to wait on.

This means you can:
- `semaphore_wait worker` - Wait for a pi coding agent in window "worker" to finish processing
- `semaphore_wait tmux:worker` - Wait for a `tmux-bash` window "worker" to exit

## Example

The LLM can use these tools to manage long-running processes:

1. Start a dev server: `tmux-bash` with name "dev" and command "npm run dev"
2. Check output: `tmux-capture` with name "dev"
3. Stop the server: `tmux-send` with name "dev" and text "C-c" (Ctrl+C)
4. Clean up: `tmux-kill` with name "dev"

To spawn a pi coding agent (single tool call):

1. Spawn agent: `tmux-coding-agent` with name "worker", folder "../hppr"
2. Wait for startup output (automatic - waits for >10 lines or 5 seconds)
3. Send task: `tmux-send` with name "worker" and text "implement feature X"
4. Wait for completion: `semaphore_wait` with name "worker" (the agent's lock, NOT "tmux:worker")
5. Check output: `tmux-capture` with name "worker"

With a specific model:

1. Spawn: `tmux-coding-agent` with name "worker", folder "../hppr", piArgs "--model claude-opus-4-6"

The manual approach (equivalent, more control):

1. Create window: `tmux-bash` with name "worker" (no command defaults to bash)
2. Start pi: `tmux-send` with name "worker" and text "pi"
3. Wait for idle: `semaphore_wait worker`
4. Send instruction: `tmux-send` with name "worker" and text "do something"

## Commands

The extension also registers a `/tmux-list` command to list active tmux windows.

## License

MIT
