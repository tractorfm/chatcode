package session

import (
	"errors"
	"os/exec"
	"testing"
	"time"
)

func hasTmux() bool {
	_, err := exec.LookPath("tmux")
	return err == nil
}

func TestManagerLimitEnforced(t *testing.T) {
	m := NewManager(2)
	if len(m.List()) != 0 {
		t.Fatal("expected empty list")
	}
	// We can't actually start tmux sessions in unit tests without tmux,
	// so test the limit logic by patching directly.
	m.sessions["a"] = &Session{}
	m.sessions["b"] = &Session{}

	_, err := m.Create(Options{SessionID: "c", Name: "c", Workdir: "/tmp"})
	if err == nil {
		t.Fatal("expected limit error")
	}
}

func TestManagerDuplicateID(t *testing.T) {
	m := NewManager(5)
	m.sessions["dup"] = &Session{}
	_, err := m.Create(Options{SessionID: "dup", Name: "dup", Workdir: "/tmp"})
	if err == nil {
		t.Fatal("expected duplicate error")
	}
}

func TestManagerWatchSessionRemovesExitedSession(t *testing.T) {
	m := NewManager(5)
	m.checkInterval = 10 * time.Millisecond
	m.isAlive = func(_ *Session) bool { return false }

	s := &Session{}
	m.sessions["gone"] = s
	go m.watchSession("gone", s)

	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if m.Get("gone") == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("expected watcher to remove exited session")
}

func TestManagerEndKeepsSessionOnKillFailure(t *testing.T) {
	m := NewManager(5)
	s := &Session{}
	m.sessions["s1"] = s
	m.endSession = func(_ *Session) error { return errors.New("kill failed") }

	if err := m.End("s1"); err == nil {
		t.Fatal("expected end error")
	}
	if got := m.Get("s1"); got == nil {
		t.Fatal("session should remain tracked when end fails")
	}
}

func TestManagerEndRemovesSessionOnSuccess(t *testing.T) {
	m := NewManager(5)
	s := &Session{}
	m.sessions["s1"] = s
	m.endSession = func(_ *Session) error { return nil }

	if err := m.End("s1"); err != nil {
		t.Fatalf("End returned error: %v", err)
	}
	if got := m.Get("s1"); got != nil {
		t.Fatal("session should be removed after successful end")
	}
}

func TestBuildEnvIncludesHostAndSessionVars(t *testing.T) {
	t.Setenv("VIBECODE_TEST_ENV", "from-host")

	s := &Session{
		opts: Options{
			Env: map[string]string{
				"VIBECODE_SESSION_ENV": "from-session",
			},
		},
	}

	env := s.buildEnv()
	if !containsEnv(env, "VIBECODE_TEST_ENV=from-host") {
		t.Fatal("expected host env variable to be inherited")
	}
	if !containsEnv(env, "VIBECODE_SESSION_ENV=from-session") {
		t.Fatal("expected session env variable to be set")
	}
}

func TestSessionTmux(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}

	outCh := make(chan OutputChunk, 64)
	m := NewManager(5)

	s, err := m.Create(Options{
		SessionID: "test-" + time.Now().Format("150405"),
		Name:      "test",
		Workdir:   t.TempDir(),
		Agent:     "none",
		OutputCh:  outCh,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer m.End(s.opts.SessionID)

	// Give tmux a moment to start
	time.Sleep(300 * time.Millisecond)

	// Inject a command
	if err := s.Input([]byte("echo hello_vibecode\n")); err != nil {
		t.Fatalf("Input: %v", err)
	}

	// Wait for output
	deadline := time.Now().Add(5 * time.Second)
	var got string
	for time.Now().Before(deadline) {
		select {
		case chunk := <-outCh:
			got += string(chunk.Data)
		default:
			time.Sleep(100 * time.Millisecond)
		}
		if contains(got, "hello_vibecode") {
			break
		}
	}

	if !contains(got, "hello_vibecode") {
		t.Fatalf("expected 'hello_vibecode' in output, got:\n%s", got)
	}
}

func TestSnapshot(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}

	m := NewManager(5)
	outCh := make(chan OutputChunk, 64)
	s, err := m.Create(Options{
		SessionID: "snap-" + time.Now().Format("150405"),
		Name:      "snap",
		Workdir:   t.TempDir(),
		Agent:     "none",
		OutputCh:  outCh,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer m.End(s.opts.SessionID)

	time.Sleep(300 * time.Millisecond)
	s.Input([]byte("echo snap_test\n"))
	time.Sleep(500 * time.Millisecond)

	content, cols, rows, err := s.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if cols <= 0 || rows <= 0 {
		t.Errorf("bad dimensions: %dx%d", cols, rows)
	}
	if !contains(content, "snap_test") {
		t.Errorf("expected 'snap_test' in snapshot:\n%s", content)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func containsEnv(env []string, wanted string) bool {
	for _, e := range env {
		if e == wanted {
			return true
		}
	}
	return false
}
