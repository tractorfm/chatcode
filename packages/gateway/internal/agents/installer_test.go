package agents

import "testing"

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
