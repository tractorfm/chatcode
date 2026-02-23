// Package gateway exposes embedded assets (templates and install scripts)
// to internal packages. The embed directives must live here because
// go:embed paths cannot traverse upward with "..".
package gateway

import _ "embed"

// Template content written into session workdirs before starting an agent.

//go:embed templates/CLAUDE.md
var DefaultClaudeMD string

//go:embed templates/AGENTS.md
var DefaultAgentsMD string

// Agent install scripts executed on agents.install commands.

//go:embed scripts/install-claude-code.sh
var InstallClaudeCodeScript string

//go:embed scripts/install-codex.sh
var InstallCodexScript string

//go:embed scripts/install-gemini.sh
var InstallGeminiScript string
