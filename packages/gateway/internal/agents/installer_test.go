package agents

import (
	"strings"
	"testing"
)

func TestAgentScript(t *testing.T) {
	tests := []struct {
		name       string
		agent      AgentName
		wantBinary string
	}{
		{name: "claude", agent: AgentClaudeCode, wantBinary: "claude"},
		{name: "codex", agent: AgentCodex, wantBinary: "codex"},
		{name: "gemini", agent: AgentGemini, wantBinary: "gemini"},
		{name: "opencode", agent: AgentOpenCode, wantBinary: "opencode"},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			script, binary, err := agentScript(tt.agent)
			if err != nil {
				t.Fatalf("agentScript(%q) error = %v", tt.agent, err)
			}
			if script == "" {
				t.Fatalf("agentScript(%q) returned empty script", tt.agent)
			}
			if binary != tt.wantBinary {
				t.Fatalf("agentScript(%q) binary = %q, want %q", tt.agent, binary, tt.wantBinary)
			}
		})
	}
}

func TestAgentScriptUnknown(t *testing.T) {
	if _, _, err := agentScript(AgentName("unknown")); err == nil {
		t.Fatal("expected error for unknown agent")
	}
}

func TestAgentScriptsUseUserLocalPrefix(t *testing.T) {
	tests := []struct {
		name  string
		agent AgentName
	}{
		{name: "claude", agent: AgentClaudeCode},
		{name: "codex", agent: AgentCodex},
		{name: "gemini", agent: AgentGemini},
		{name: "opencode", agent: AgentOpenCode},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			script, _, err := agentScript(tt.agent)
			if err != nil {
				t.Fatalf("agentScript(%q) error = %v", tt.agent, err)
			}
			if !strings.Contains(script, "npm install -g --prefix \"${LOCAL_PREFIX}\"") {
				t.Fatalf("agentScript(%q) does not install via user-local prefix", tt.agent)
			}
			if !strings.Contains(script, "run this installer as the target non-root user") {
				t.Fatalf("agentScript(%q) does not guard against root installs", tt.agent)
			}
			if strings.Contains(script, "sudo -n npm install -g") {
				t.Fatalf("agentScript(%q) still uses sudo npm global installs", tt.agent)
			}
			if strings.Contains(script, "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -") {
				t.Fatalf("agentScript(%q) still contains the unreachable root-only Node install path", tt.agent)
			}
		})
	}
}
