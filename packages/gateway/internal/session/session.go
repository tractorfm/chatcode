package session

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	terminationPollInterval = 500 * time.Millisecond
	terminationTimeout      = 3 * time.Second
	forceKillWait           = 500 * time.Millisecond
)

// Options configures a new session.
type Options struct {
	// SessionID is the stable CP-assigned ID.
	SessionID string
	// Name is a human-readable label (used as the tmux session name).
	Name string
	// Workdir is the working directory for the session.
	Workdir string
	// Agent identifies which AI agent to launch. Empty → plain shell.
	Agent string
	// ClaudeMD overrides the default CLAUDE.md content.
	ClaudeMD string
	// AgentsMD overrides the default AGENTS.md content.
	AgentsMD string
	// Env contains extra environment variables.
	Env map[string]string
	// OutputCh receives batched PTY output frames (payload only, not framed).
	// The caller is responsible for framing and sending over WebSocket.
	OutputCh chan OutputChunk
}

// OutputChunk is a batch of PTY output from a session.
type OutputChunk struct {
	SessionID string
	Seq       uint64
	Data      []byte
}

// Summary is a lightweight snapshot of session state.
type Summary struct {
	SessionID      string
	Name           string
	LastActivityAt time.Time
}

// Session represents one tmux-backed PTY session.
type Session struct {
	opts Options

	tmuxName string // tmux session name (unique, uses SessionID)

	seq            uint64 // atomic sequence counter for output frames
	lastActivityAt int64  // unix nano, updated atomically

	capturer *outputCapturer
}

func newSession(opts Options) *Session {
	return &Session{
		opts:     opts,
		tmuxName: "vibe-" + opts.SessionID,
	}
}

// start writes agent instruction files and launches the tmux session.
func (s *Session) start() error {
	if err := writeTemplates(s.opts); err != nil {
		return fmt.Errorf("write templates: %w", err)
	}

	cmd := s.buildTmuxNewSessionCmd()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux new-session: %w: %s", err, out)
	}

	s.capturer = newOutputCapturer(s.tmuxName, s.opts.SessionID, &s.seq, &s.lastActivityAt, s.opts.OutputCh)
	s.capturer.start()

	atomic.StoreInt64(&s.lastActivityAt, time.Now().UnixNano())
	return nil
}

// buildTmuxNewSessionCmd returns the exec.Cmd to start the tmux session.
func (s *Session) buildTmuxNewSessionCmd() *exec.Cmd {
	shellCmd := s.agentCommand()

	args := []string{
		"new-session",
		"-d",             // detached
		"-s", s.tmuxName, // session name
		"-c", s.opts.Workdir, // start dir
		"--",
		"sh", "-c", shellCmd,
	}
	cmd := exec.Command("tmux", args...)
	cmd.Env = s.buildEnv()
	return cmd
}

// agentCommand returns the shell command to run inside tmux.
func (s *Session) agentCommand() string {
	switch s.opts.Agent {
	case "claude-code":
		return "claude"
	case "codex":
		return "codex"
	case "gemini":
		return "gemini"
	case "opencode":
		return "opencode"
	default:
		return "$SHELL"
	}
}

// buildEnv merges the host environment with session-specific overrides.
func (s *Session) buildEnv() []string {
	base := append([]string(nil), hostEnv()...)
	for k, v := range s.opts.Env {
		base = append(base, k+"="+v)
	}
	return base
}

// Input injects keystrokes into the tmux pane.
func (s *Session) Input(data []byte) error {
	atomic.StoreInt64(&s.lastActivityAt, time.Now().UnixNano())
	// tmux send-keys with -l sends literal bytes (no special key interpretation)
	cmd := exec.Command("tmux", "send-keys", "-t", s.tmuxName, "-l", string(data))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys: %w: %s", err, out)
	}
	return nil
}

// Resize resizes the tmux window.
func (s *Session) Resize(cols, rows int) error {
	cmd := exec.Command("tmux", "resize-window", "-t", s.tmuxName,
		"-x", fmt.Sprintf("%d", cols),
		"-y", fmt.Sprintf("%d", rows))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux resize-window: %w: %s", err, out)
	}
	return nil
}

// Snapshot returns the current terminal content via tmux capture-pane.
func (s *Session) Snapshot() (string, int, int, error) {
	// Get content
	out, err := exec.Command("tmux", "capture-pane", "-t", s.tmuxName, "-p").Output()
	if err != nil {
		return "", 0, 0, fmt.Errorf("capture-pane: %w", err)
	}

	// Get dimensions
	cols, rows := 80, 24
	dimOut, err := exec.Command(
		"tmux", "display-message", "-t", s.tmuxName, "-p", "#{window_width} #{window_height}",
	).Output()
	if err == nil {
		fmt.Sscanf(string(dimOut), "%d %d", &cols, &rows)
	}

	return string(out), cols, rows, nil
}

// kill terminates the tmux session.
func (s *Session) kill() error {
	s.stopCapture()
	panePIDs := s.listPanePIDs()

	// Graceful attempt via tmux session kill.
	if err := s.killTmuxSession(); err != nil && s.isAlive() {
		return err
	}
	if s.waitForExit(terminationTimeout, terminationPollInterval) {
		return nil
	}

	// Force underlying pane processes if tmux session is still alive.
	s.signalPIDs(panePIDs, syscall.SIGTERM)
	if s.waitForExit(forceKillWait, 100*time.Millisecond) {
		return nil
	}
	s.signalPIDs(panePIDs, syscall.SIGKILL)

	// Final best-effort tmux kill and exit check.
	_ = s.killTmuxSession()
	if s.waitForExit(forceKillWait, 100*time.Millisecond) {
		return nil
	}

	return fmt.Errorf("session %q did not terminate within %s", s.opts.SessionID, terminationTimeout+2*forceKillWait)
}

func (s *Session) killTmuxSession() error {
	cmd := exec.Command("tmux", "kill-session", "-t", s.tmuxName)
	if out, err := cmd.CombinedOutput(); err != nil {
		if !s.isAlive() {
			return nil
		}
		return fmt.Errorf("tmux kill-session: %w: %s", err, out)
	}
	return nil
}

func (s *Session) waitForExit(timeout, interval time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !s.isAlive() {
			return true
		}
		time.Sleep(interval)
	}
	return !s.isAlive()
}

func (s *Session) listPanePIDs() []int {
	out, err := exec.Command("tmux", "list-panes", "-t", s.tmuxName, "-F", "#{pane_pid}").Output()
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	pids := make([]int, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		pid, err := strconv.Atoi(line)
		if err != nil || pid <= 0 {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}

func (s *Session) signalPIDs(pids []int, sig syscall.Signal) {
	for _, pid := range pids {
		proc, err := os.FindProcess(pid)
		if err != nil {
			continue
		}
		_ = proc.Signal(sig)
	}
}

func (s *Session) stopCapture() {
	if s.capturer != nil {
		s.capturer.stop()
	}
}

func (s *Session) isAlive() bool {
	return exec.Command("tmux", "has-session", "-t", s.tmuxName).Run() == nil
}

// Summary returns lightweight session metadata.
func (s *Session) Summary() Summary {
	nanos := atomic.LoadInt64(&s.lastActivityAt)
	return Summary{
		SessionID:      s.opts.SessionID,
		Name:           s.opts.Name,
		LastActivityAt: time.Unix(0, nanos),
	}
}

// hostEnv returns the current process environment as a slice of "KEY=VALUE" strings.
func hostEnv() []string {
	return os.Environ()
}
