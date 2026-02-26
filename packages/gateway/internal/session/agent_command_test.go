package session

import "testing"

func TestAgentCommand(t *testing.T) {
	tests := []struct {
		name   string
		agent  string
		want   string
	}{
		{name: "claude", agent: "claude-code", want: "claude"},
		{name: "codex", agent: "codex", want: "codex"},
		{name: "gemini", agent: "gemini", want: "gemini"},
		{name: "opencode", agent: "opencode", want: "opencode"},
		{name: "none", agent: "none", want: "$SHELL"},
		{name: "empty", agent: "", want: "$SHELL"},
		{name: "unknown", agent: "unknown", want: "$SHELL"},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			s := &Session{opts: Options{Agent: tt.agent}}
			if got := s.agentCommand(); got != tt.want {
				t.Fatalf("agentCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}
