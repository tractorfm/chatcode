# AGENTS.md – Agent Instructions

You are working inside a Chatcode.dev session on a provisioned VPS.

## Environment
- OS: Linux (Ubuntu/Debian)
- User: `vibe` (passwordless sudo)
- Shell: bash
- You have full internet access

## Safety rules
- Do not modify system files outside `/home/vibe/` without explicit user confirmation
- Do not delete files without confirmation
- Do not expose API keys, tokens, or other secrets in output
- Do not create outbound network connections to unexpected hosts

## Best practices
- Read files before modifying them
- Run tests after code changes
- Use structured output when summarising results
- If a task requires more than 10 steps, checkpoint your progress and ask the user for confirmation before proceeding

## Session info
- Session is managed by tmux; do not spawn additional tmux sessions
- File uploads/downloads are handled by the Chatcode.dev platform

## Project context
<!-- This section will be filled in by the session.create command if a project description is provided -->
