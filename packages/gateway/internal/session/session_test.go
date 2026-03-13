package session

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
	m.livenessStatus = func(_ *Session) sessionLiveness { return sessionLivenessGone }

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

func TestManagerWatchSessionCallsExitHookOnce(t *testing.T) {
	m := NewManager(5)
	m.checkInterval = 10 * time.Millisecond
	m.livenessStatus = func(_ *Session) sessionLiveness { return sessionLivenessGone }

	calls := make(chan string, 1)
	m.SetOnSessionExit(func(sessionID string) {
		calls <- sessionID
	})

	s := &Session{}
	m.sessions["gone"] = s
	go m.watchSession("gone", s)

	select {
	case sessionID := <-calls:
		if sessionID != "gone" {
			t.Fatalf("exit hook sessionID = %q, want %q", sessionID, "gone")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected exit hook to fire")
	}
}

func TestManagerWatchSessionIgnoresUnknownLiveness(t *testing.T) {
	m := NewManager(5)
	m.checkInterval = 10 * time.Millisecond
	m.livenessStatus = func(_ *Session) sessionLiveness { return sessionLivenessUnknown }

	s := &Session{}
	m.sessions["flaky"] = s
	go m.watchSession("flaky", s)

	time.Sleep(50 * time.Millisecond)
	if m.Get("flaky") == nil {
		t.Fatal("session should remain tracked on unknown liveness")
	}
}

func TestManagerWatchSessionRequiresConsecutiveGoneChecks(t *testing.T) {
	m := NewManager(5)
	m.checkInterval = 10 * time.Millisecond
	states := []sessionLiveness{
		sessionLivenessGone,
		sessionLivenessAlive,
		sessionLivenessGone,
		sessionLivenessGone,
	}
	var idx int
	m.livenessStatus = func(_ *Session) sessionLiveness {
		if idx >= len(states) {
			return sessionLivenessGone
		}
		state := states[idx]
		idx++
		return state
	}

	s := &Session{}
	m.sessions["flaky"] = s
	go m.watchSession("flaky", s)

	time.Sleep(25 * time.Millisecond)
	if m.Get("flaky") == nil {
		t.Fatal("session should survive a single gone check")
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if m.Get("flaky") == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("expected watcher to remove session after consecutive gone checks")
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

func TestManagerRecoverAddsDiscoveredSessions(t *testing.T) {
	m := NewManager(5)
	m.checkInterval = time.Hour
	m.isAlive = func(_ *Session) bool { return true }
	m.listRecoverableSessionIDs = func() ([]string, error) {
		return []string{"ses-a", "ses-b"}, nil
	}
	m.newRecoveredSession = func(sessionID string, _ chan OutputChunk) *Session {
		return &Session{opts: Options{SessionID: sessionID}}
	}

	recovered, err := m.Recover(make(chan OutputChunk, 8))
	if err != nil {
		t.Fatalf("Recover returned error: %v", err)
	}

	if len(recovered) != 2 {
		t.Fatalf("expected 2 recovered sessions, got %d", len(recovered))
	}
	if m.Get("ses-a") == nil || m.Get("ses-b") == nil {
		t.Fatal("expected recovered sessions to be tracked")
	}
}

func TestManagerRecoverIgnoresCreateLimit(t *testing.T) {
	m := NewManager(2)
	m.checkInterval = time.Hour
	m.isAlive = func(_ *Session) bool { return true }
	m.sessions["existing"] = &Session{}
	m.listRecoverableSessionIDs = func() ([]string, error) {
		return []string{"ses-a", "ses-b"}, nil
	}
	m.newRecoveredSession = func(sessionID string, _ chan OutputChunk) *Session {
		return &Session{opts: Options{SessionID: sessionID}}
	}

	recovered, err := m.Recover(make(chan OutputChunk, 8))
	if err != nil {
		t.Fatalf("Recover returned error: %v", err)
	}

	if len(recovered) != 2 {
		t.Fatalf("expected 2 recovered sessions, got %d", len(recovered))
	}
	if m.Get("ses-a") == nil || m.Get("ses-b") == nil {
		t.Fatal("expected recovered sessions to be tracked")
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

func TestBuildTmuxNewSessionCmdSetsTERMInEnv(t *testing.T) {
	detectedTmuxTerminal = "screen-256color"
	detectTmuxTermOnce = sync.Once{}
	detectTmuxTermOnce.Do(func() { detectedTmuxTerminal = "screen-256color" })

	s := &Session{
		opts: Options{
			SessionID: "ses-test",
			Workdir:   "/tmp",
			Agent:     "claude-code",
		},
		tmuxName: "vibe-ses-test",
	}

	cmd := s.buildTmuxNewSessionCmd()
	if len(cmd.Args) < 2 {
		t.Fatalf("unexpected tmux args: %v", cmd.Args)
	}
	shellCmd := cmd.Args[len(cmd.Args)-1]
	if !contains(shellCmd, "if command -v claude") {
		t.Fatalf("expected agent shell command, got %q", shellCmd)
	}
	if contains(shellCmd, "TERM=") {
		t.Fatalf("shell command should not inline TERM assignment, got %q", shellCmd)
	}
	if !containsEnv(cmd.Env, "TERM=screen-256color") {
		t.Fatalf("expected TERM in command env, got %v", cmd.Env)
	}
}

func TestSetHistoryLimitArgs(t *testing.T) {
	args := setHistoryLimitArgs("vibe-ses-test")
	if len(args) != 5 {
		t.Fatalf("unexpected args length: %d", len(args))
	}
	if args[0] != "set-option" || args[1] != "-t" || args[2] != "vibe-ses-test" {
		t.Fatalf("unexpected args prefix: %v", args[:3])
	}
	if args[3] != "history-limit" {
		t.Fatalf("expected history-limit option, got %q", args[3])
	}
	gotLimit, err := strconv.Atoi(args[4])
	if err != nil || gotLimit != tmuxHistoryLimitLines {
		t.Fatalf("unexpected history limit arg: %q", args[4])
	}
}

func TestSetDefaultTerminalArgs(t *testing.T) {
	args := setDefaultTerminalArgs("tmux-256color")
	want := []string{"set-option", "-g", "default-terminal", "tmux-256color"}
	if len(args) != len(want) {
		t.Fatalf("args len = %d, want %d", len(args), len(want))
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args[%d] = %q, want %q", i, args[i], want[i])
		}
	}
}

func TestLiteralSendKeysArgs(t *testing.T) {
	args := literalSendKeysArgs("vibe-ses-test", "--dangerously-skip-permissions")
	want := []string{"send-keys", "-t", "vibe-ses-test", "-l", "--", "--dangerously-skip-permissions"}
	if len(args) != len(want) {
		t.Fatalf("args len = %d, want %d", len(args), len(want))
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args[%d] = %q, want %q", i, args[i], want[i])
		}
	}
}

func TestSessionLivenessFromHasSessionOutput(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want sessionLiveness
	}{
		{name: "gone", out: "can't find session: vibe-ses-test", want: sessionLivenessGone},
		{name: "no server", out: "no server running on /tmp/chatcode/tmux-1001/default", want: sessionLivenessGone},
		{name: "failed connect", out: "failed to connect to server", want: sessionLivenessUnknown},
		{name: "missing socket", out: "no such file or directory", want: sessionLivenessUnknown},
		{name: "other", out: "unexpected tmux failure", want: sessionLivenessUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sessionLivenessFromHasSessionOutput([]byte(tt.out)); got != tt.want {
				t.Fatalf("sessionLivenessFromHasSessionOutput(%q) = %v, want %v", tt.out, got, tt.want)
			}
		})
	}
}

func TestIsShellCommand(t *testing.T) {
	tests := []struct {
		name string
		cmd  string
		want bool
	}{
		{name: "bash", cmd: "bash", want: true},
		{name: "path zsh", cmd: "/bin/zsh", want: true},
		{name: "trimmed sh", cmd: " sh\n", want: true},
		{name: "htop", cmd: "htop", want: false},
		{name: "vim", cmd: "/usr/bin/vim", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isShellCommand(tt.cmd); got != tt.want {
				t.Fatalf("isShellCommand(%q) = %v, want %v", tt.cmd, got, tt.want)
			}
		})
	}
}

func TestSelectTmuxDefaultTerminal(t *testing.T) {
	tests := []struct {
		name     string
		canProbe bool
		exists   map[string]bool
		want     string
	}{
		{
			name:     "prefer tmux-256color",
			canProbe: true,
			exists:   map[string]bool{"tmux-256color": true, "screen-256color": true, "screen": true},
			want:     "tmux-256color",
		},
		{
			name:     "fallback to screen-256color",
			canProbe: true,
			exists:   map[string]bool{"tmux-256color": false, "screen-256color": true, "screen": true},
			want:     "screen-256color",
		},
		{
			name:     "fallback to screen",
			canProbe: true,
			exists:   map[string]bool{"tmux-256color": false, "screen-256color": false, "screen": true},
			want:     "screen",
		},
		{
			name:     "no probe uses legacy",
			canProbe: false,
			exists:   map[string]bool{},
			want:     "screen",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := selectTmuxDefaultTerminal(func(term string) bool { return tt.exists[term] }, tt.canProbe)
			if got != tt.want {
				t.Fatalf("selectTmuxDefaultTerminal = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSnapshotCaptureArgs(t *testing.T) {
	args := snapshotCaptureArgs("vibe-ses-test")
	want := []string{"capture-pane", "-e", "-N", "-S", "-" + strconv.Itoa(snapshotHistoryLines), "-t", "vibe-ses-test", "-p"}
	if len(args) != len(want) {
		t.Fatalf("args len = %d, want %d", len(args), len(want))
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args[%d] = %q, want %q", i, args[i], want[i])
		}
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

	if _, err := os.Stat(filepath.Join(s.opts.Workdir, "AGENTS.md")); !os.IsNotExist(err) {
		t.Fatalf("AGENTS.md should not be created in workdir, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(s.opts.Workdir, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("CLAUDE.md should not be created in workdir, err=%v", err)
	}
}

func TestSessionInputAcceptsLeadingDoubleDashPaste(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}

	outCh := make(chan OutputChunk, 64)
	m := NewManager(5)

	s, err := m.Create(Options{
		SessionID: "dash-" + time.Now().Format("150405"),
		Name:      "dash",
		Workdir:   t.TempDir(),
		Agent:     "none",
		OutputCh:  outCh,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer m.End(s.opts.SessionID)

	time.Sleep(300 * time.Millisecond)

	if err := s.Input([]byte("--dangerously-skip-permissions")); err != nil {
		t.Fatalf("Input leading double dash: %v", err)
	}

	time.Sleep(200 * time.Millisecond)

	content, _, _, _, _, _, _, err := s.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(content, "\r", ""), "\n", "")
	if !contains(normalized, "--dangerously-skip-permissions") {
		t.Fatalf("expected pasted text in snapshot, got:\n%s", content)
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

	content, cols, rows, cursorX, cursorY, cursorVisible, _, err := s.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if cols <= 0 || rows <= 0 {
		t.Errorf("bad dimensions: %dx%d", cols, rows)
	}
	if cursorX < 0 || cursorY < 0 {
		t.Errorf("bad cursor position: %d,%d", cursorX, cursorY)
	}
	if cursorVisible != 0 && cursorVisible != 1 {
		t.Errorf("bad cursor visibility: %d", cursorVisible)
	}
	if !contains(content, "snap_test") {
		t.Errorf("expected 'snap_test' in snapshot:\n%s", content)
	}
}

func TestSnapshotIncludesScrollbackAndANSI(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}

	m := NewManager(5)
	outCh := make(chan OutputChunk, 64)
	s, err := m.Create(Options{
		SessionID: "hist-" + time.Now().Format("150405"),
		Name:      "hist",
		Workdir:   t.TempDir(),
		Agent:     "none",
		OutputCh:  outCh,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer m.End(s.opts.SessionID)

	time.Sleep(300 * time.Millisecond)
	if err := s.Input([]byte("printf '\\033[31mred_test\\033[0m\\n'\n")); err != nil {
		t.Fatalf("Input ANSI: %v", err)
	}
	for i := 0; i < 140; i++ {
		line := "echo scroll_line_" + strconv.Itoa(i) + "\n"
		if err := s.Input([]byte(line)); err != nil {
			t.Fatalf("Input scroll line %d: %v", i, err)
		}
	}
	time.Sleep(1200 * time.Millisecond)

	content, _, _, _, _, _, _, err := s.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if !contains(content, "scroll_line_0") {
		t.Fatalf("expected snapshot to include scrollback line, got:\n%s", content)
	}
	if !contains(content, "\x1b[31mred_test") {
		t.Fatalf("expected snapshot to preserve ANSI escapes, got:\n%s", content)
	}
}

func TestManagerEndGracefullyCapturesExitOutput(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}

	outCh := make(chan OutputChunk, 128)
	m := NewManager(5)

	s, err := m.Create(Options{
		SessionID: "end-" + time.Now().Format("150405"),
		Name:      "end",
		Workdir:   t.TempDir(),
		OutputCh:  outCh,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	time.Sleep(300 * time.Millisecond)
	if err := s.Input([]byte("trap 'printf \"graceful_exit_test\\n\"' EXIT\n")); err != nil {
		t.Fatalf("Input trap: %v", err)
	}
	time.Sleep(300 * time.Millisecond)

	if err := m.End(s.opts.SessionID); err != nil {
		t.Fatalf("End: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	var got string
	for time.Now().Before(deadline) {
		select {
		case chunk := <-outCh:
			got += string(chunk.Data)
			if contains(got, "graceful_exit_test") {
				return
			}
		default:
			time.Sleep(100 * time.Millisecond)
		}
	}

	t.Fatalf("expected graceful exit output, got:\n%s", got)
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
