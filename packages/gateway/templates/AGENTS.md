# Chatcode Global AGENTS.md

You are running inside a Chatcode-managed terminal session on a user-controlled machine.

- Scope: prefer changes inside the current repo/workspace and the user's home directory.
- Safety: ask before `sudo`, system package installs, service changes, or destructive deletes.
- Secrets: never print, copy, or persist tokens, keys, or credentials.
- Session model: the terminal is tmux-backed already; do not start nested tmux sessions.
- Workflow: inspect before editing, keep patches minimal, run relevant tests, and report concrete changes plus remaining risk.
