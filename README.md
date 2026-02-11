# pi-tmux

Tmux tools for [pi](https://github.com/badlogic/pi-mono) to run long-running commands and control panes by lock name.

## Requirements

- Must be running inside a tmux session (`TMUX` env var set)
- tmux must be installed
- [pi-semaphore](https://github.com/offline-ant/pi-semaphore) should be installed

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
| `tmux-bash` | Create a new tmux pane with a lock name and execute a command (defaults to `bash`) |
| `tmux-capture` | Capture output from a pane by lock name or pane id |
| `tmux-send` | Send text or keys to a pane by lock name or pane id |
| `tmux-kill` | Kill a pane by lock name or pane id |
| `tmux-coding-agent` | Spawn a pi coding agent in a pane and return startup output |

## Lock + Pane Mapping

`tmux-bash` creates a lock in `/tmp/pi-semaphores/<name>`.

- The lock file content is the tmux pane id (for example `%42`)
- Control tools resolve `<name> -> pane id` and target that pane
- When the command exits, the lock is removed and `idle:<name>` is written

This allows any agent in the same tmux server to control panes it did not spawn, as long as it knows the lock name.

## Example

1. Start: `tmux-bash` with name `worker` and command `npm run dev`
2. Capture: `tmux-capture` with name `worker`
3. Send keys: `tmux-send` with name `worker` and text `C-c`
4. Kill: `tmux-kill` with name `worker`

Spawn a coding agent:

1. `tmux-coding-agent` with name `reviewer`, folder `../project`
2. `tmux-send` with name `reviewer` and text `analyze lint failures`
3. `semaphore_wait` with name `reviewer`

## Commands

- `/tmux-list` lists active tmux panes

## License

MIT
