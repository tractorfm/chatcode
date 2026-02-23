package session

import (
	"os"
	"path/filepath"

	gw "github.com/tractorfm/chatcode/packages/gateway"
)

// writeTemplates writes CLAUDE.md and AGENTS.md into the session workdir.
// It uses custom content from opts if provided, otherwise the embedded defaults.
func writeTemplates(opts Options) error {
	if err := os.MkdirAll(opts.Workdir, 0o755); err != nil {
		return err
	}

	claudeMD := gw.DefaultClaudeMD
	if opts.ClaudeMD != "" {
		claudeMD = opts.ClaudeMD
	}

	agentsMD := gw.DefaultAgentsMD
	if opts.AgentsMD != "" {
		agentsMD = opts.AgentsMD
	}

	if err := os.WriteFile(filepath.Join(opts.Workdir, "CLAUDE.md"), []byte(claudeMD), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(opts.Workdir, "AGENTS.md"), []byte(agentsMD), 0o644)
}
