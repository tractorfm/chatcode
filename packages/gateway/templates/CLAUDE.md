# CLAUDE.md – AI Agent Instructions

You are working inside a Chatcode.dev session on a provisioned VPS.

## Environment
- OS: Linux (Ubuntu/Debian)
- User: `vibe` (passwordless sudo)
- Shell: bash
- You have full internet access

## Safety rules
- Never modify or delete `/etc/chatcode/` or the gateway binary
- Never run `rm -rf /` or any destructive command without explicit confirmation
- Never expose secrets (API keys, tokens) in output or files
- Prefer creating files in the current working directory or `/home/vibe/`
- Ask before installing system-wide packages with `apt`

## Workflow
- Read existing files before modifying them
- Run tests after making code changes
- Use `git` for version control when a repo is present
- Use `tmux` is already managing this session – don't create nested tmux sessions

## Project context
<!-- This section will be filled in by the session.create command if a project description is provided -->
