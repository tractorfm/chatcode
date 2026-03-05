package agents

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestListStatus(t *testing.T) {
	binDir := t.TempDir()
	writeFakeBin := func(name, version string) {
		t.Helper()
		path := filepath.Join(binDir, name)
		body := "#!/usr/bin/env bash\necho \"" + version + "\"\n"
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatalf("write fake %s: %v", name, err)
		}
	}

	writeFakeBin("claude", "claude 1.2.3")
	writeFakeBin("codex", "codex 9.8.7")
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))

	got := ListStatus()
	if len(got) != 4 {
		t.Fatalf("ListStatus len = %d, want 4", len(got))
	}

	statusByAgent := make(map[AgentName]Status, len(got))
	for _, s := range got {
		statusByAgent[s.Agent] = s
	}

	if !statusByAgent[AgentClaudeCode].Installed || !strings.Contains(statusByAgent[AgentClaudeCode].Version, "claude 1.2.3") {
		t.Fatalf("claude status unexpected: %+v", statusByAgent[AgentClaudeCode])
	}
	if !statusByAgent[AgentCodex].Installed || !strings.Contains(statusByAgent[AgentCodex].Version, "codex 9.8.7") {
		t.Fatalf("codex status unexpected: %+v", statusByAgent[AgentCodex])
	}
	if statusByAgent[AgentGemini].Installed {
		t.Fatalf("gemini should be not installed: %+v", statusByAgent[AgentGemini])
	}
	if statusByAgent[AgentOpenCode].Installed {
		t.Fatalf("opencode should be not installed: %+v", statusByAgent[AgentOpenCode])
	}
}

func TestListStatusSkipsSlowVersionProbe(t *testing.T) {
	binDir := t.TempDir()
	writeFakeBin := func(name, body string) {
		t.Helper()
		path := filepath.Join(binDir, name)
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatalf("write fake %s: %v", name, err)
		}
	}

	writeFakeBin("claude", "#!/usr/bin/env bash\necho \"claude 1.0.0\"\n")
	writeFakeBin("codex", "#!/usr/bin/env bash\necho \"codex 1.0.0\"\n")
	writeFakeBin("gemini", "#!/usr/bin/env bash\nend=$((SECONDS+3)); while [ \"$SECONDS\" -lt \"$end\" ]; do :; done\necho \"gemini 1.0.0\"\n")
	writeFakeBin("opencode", "#!/usr/bin/env bash\necho \"opencode 1.0.0\"\n")
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))

	start := time.Now()
	got := ListStatus()
	elapsed := time.Since(start)
	if elapsed > 2500*time.Millisecond {
		t.Fatalf("ListStatus took %v, expected timeout on slow version probe", elapsed)
	}

	statusByAgent := make(map[AgentName]Status, len(got))
	for _, s := range got {
		statusByAgent[s.Agent] = s
	}

	gemini := statusByAgent[AgentGemini]
	if !gemini.Installed {
		t.Fatalf("gemini should be marked installed: %+v", gemini)
	}
	if gemini.Version != "" {
		t.Fatalf("gemini version should be empty after timeout: %+v", gemini)
	}
}
