package session

import (
	"strings"
	"testing"
)

func TestAgentCommand(t *testing.T) {
	tests := []struct {
		name   string
		agent  string
		want   string
		parts  []string
	}{
		{
			name:  "claude",
			agent: "claude-code",
			parts: []string{"command -v claude", "claude-code exited", "exec \"${SHELL:-/bin/bash}\""},
		},
		{
			name:  "codex",
			agent: "codex",
			parts: []string{"command -v codex", "codex exited", "exec \"${SHELL:-/bin/bash}\""},
		},
		{
			name:  "gemini",
			agent: "gemini",
			parts: []string{"command -v gemini", "gemini exited", "exec \"${SHELL:-/bin/bash}\""},
		},
		{
			name:  "opencode",
			agent: "opencode",
			parts: []string{"command -v opencode", "opencode exited", "exec \"${SHELL:-/bin/bash}\""},
		},
		{name: "none", agent: "none", want: defaultShellCommand},
		{name: "empty", agent: "", want: defaultShellCommand},
		{name: "unknown", agent: "unknown", want: defaultShellCommand},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			s := &Session{opts: Options{Agent: tt.agent}}
			got := s.agentCommand()
			if tt.want != "" && got != tt.want {
				t.Fatalf("agentCommand() = %q, want %q", got, tt.want)
			}
			for _, part := range tt.parts {
				if !strings.Contains(got, part) {
					t.Fatalf("agentCommand() = %q, expected substring %q", got, part)
				}
			}
		})
	}
}
