package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	terminationPollInterval = 500 * time.Millisecond
	terminationTimeout      = 3 * time.Second
	forceKillWait           = 500 * time.Millisecond
	gracefulExitWait        = 750 * time.Millisecond
	tmuxHistoryLimitLines   = 200000
	snapshotHistoryLines    = 50000
	preferredTmuxTerminal   = "tmux-256color"
	fallbackTmuxTerminal    = "screen-256color"
	legacyTmuxTerminal      = "screen"
	defaultShellCommand     = "${SHELL:-/bin/bash}"
)

var (
	detectedTmuxTerminal string
	detectTmuxTermOnce   sync.Once
)

const osc8Prefix = "\x1b]8;;"

type sessionLiveness int

const (
	sessionLivenessAlive sessionLiveness = iota
	sessionLivenessGone
	sessionLivenessUnknown
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
	cmd := s.buildTmuxNewSessionCmd()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux new-session: %w: %s", err, out)
	}
	if err := s.ensureHistoryLimit(); err != nil {
		return err
	}
	if err := s.ensureDefaultTerminal(); err != nil {
		return err
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
	cmd.Env = append(s.buildEnv(), "TERM="+detectTmuxDefaultTerminal())
	return cmd
}

// agentCommand returns the shell command to run inside tmux.
func (s *Session) agentCommand() string {
	switch s.opts.Agent {
	case "claude-code":
		return buildAgentLaunchCommand("claude-code", "claude")
	case "codex":
		return buildAgentLaunchCommand("codex", "codex")
	case "gemini":
		return buildAgentLaunchCommand("gemini", "gemini")
	case "opencode":
		return buildAgentLaunchCommand("opencode", "opencode")
	default:
		return defaultShellCommand
	}
}

func buildAgentLaunchCommand(agentType, binary string) string {
	return fmt.Sprintf(
		`if command -v %[1]s >/dev/null 2>&1; then %[1]s; ec=$?; printf '\n[chatcode] %[2]s exited (code %%s); starting shell.\n' "$ec"; else printf '\n[chatcode] %[2]s is not installed. Run agents.install and retry.\n'; fi; exec "${SHELL:-/bin/bash}"`,
		binary,
		agentType,
	)
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
	cmd := exec.Command("tmux", literalSendKeysArgs(s.tmuxName, string(data))...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys: %w: %s", err, out)
	}
	return nil
}

func (s *Session) sendKeys(keys ...string) error {
	args := append([]string{"send-keys", "-t", s.tmuxName}, keys...)
	cmd := exec.Command("tmux", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux send-keys: %w: %s", err, out)
	}
	return nil
}

func (s *Session) sendLiteral(text string) error {
	cmd := exec.Command("tmux", literalSendKeysArgs(s.tmuxName, text)...)
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

// Snapshot returns the current terminal content and terminal geometry/cursor state.
// cursorX/cursorY are 0-based positions within the current visible pane.
// cursorVisible is 1 (visible), 0 (hidden), or -1 when unknown.
func (s *Session) Snapshot() (content string, cols, rows, cursorX, cursorY, cursorVisible int, alternateOn bool, err error) {
	// Capture recent pane history with ANSI escapes to preserve color output.
	out, err := exec.Command("tmux", snapshotCaptureArgs(s.tmuxName)...).Output()
	if err != nil {
		return "", 0, 0, -1, -1, -1, false, fmt.Errorf("capture-pane: %w", err)
	}

	// Get dimensions and cursor position in one tmux call.
	cols, rows = 80, 24
	cursorX, cursorY, cursorVisible = -1, -1, -1
	alternateOn = false

	stateOut, err := exec.Command(
		"tmux", "display-message", "-t", s.tmuxName, "-p", "#{window_width} #{window_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on}",
	).Output()
	if err == nil {
		var alternateInt int
		fmt.Sscanf(string(stateOut), "%d %d %d %d %d %d", &cols, &rows, &cursorX, &cursorY, &cursorVisible, &alternateInt)
		alternateOn = alternateInt == 1
	}

	return stripOSC8Hyperlinks(string(out)), cols, rows, cursorX, cursorY, cursorVisible, alternateOn, nil
}

func (s *Session) ensureHistoryLimit() error {
	cmd := exec.Command("tmux", setHistoryLimitArgs(s.tmuxName)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux set history-limit: %w: %s", err, out)
	}
	return nil
}

func (s *Session) ensureDefaultTerminal() error {
	cmd := exec.Command("tmux", setDefaultTerminalArgs(detectTmuxDefaultTerminal())...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux set default-terminal: %w: %s", err, out)
	}
	return nil
}

func setHistoryLimitArgs(tmuxName string) []string {
	return []string{"set-option", "-t", tmuxName, "history-limit", fmt.Sprintf("%d", tmuxHistoryLimitLines)}
}

func setDefaultTerminalArgs(term string) []string {
	return []string{"set-option", "-g", "default-terminal", term}
}

func literalSendKeysArgs(tmuxName, text string) []string {
	// `--` ensures leading pasted text like `--dangerously-skip-permissions`
	// is treated as literal input rather than tmux flags.
	return []string{"send-keys", "-t", tmuxName, "-l", "--", text}
}

func detectTmuxDefaultTerminal() string {
	detectTmuxTermOnce.Do(func() {
		infocmpPath, err := exec.LookPath("infocmp")
		if err != nil {
			// If we cannot probe terminfo availability, use the most compatible
			// term name to avoid unknown-terminal failures in ncurses apps.
			detectedTmuxTerminal = legacyTmuxTerminal
			return
		}
		detectedTmuxTerminal = selectTmuxDefaultTerminal(func(term string) bool {
			return exec.Command(infocmpPath, term).Run() == nil
		}, true)
	})
	return detectedTmuxTerminal
}

func selectTmuxDefaultTerminal(termExists func(string) bool, canProbe bool) string {
	if !canProbe {
		return legacyTmuxTerminal
	}
	candidates := []string{preferredTmuxTerminal, fallbackTmuxTerminal, legacyTmuxTerminal}
	for _, term := range candidates {
		if termExists(term) {
			return term
		}
	}
	return legacyTmuxTerminal
}

func snapshotCaptureArgs(tmuxName string) []string {
	return []string{
		"capture-pane",
		"-e",
		"-N",
		"-S", fmt.Sprintf("-%d", snapshotHistoryLines),
		"-t", tmuxName,
		"-p",
	}
}

func stripOSC8Hyperlinks(content string) string {
	if !strings.Contains(content, osc8Prefix) {
		return content
	}

	var out strings.Builder
	out.Grow(len(content))

	for i := 0; i < len(content); {
		if !strings.HasPrefix(content[i:], osc8Prefix) {
			out.WriteByte(content[i])
			i++
			continue
		}

		start := i
		i += len(osc8Prefix)
		terminated := false
		for i < len(content) {
			switch content[i] {
			case '\a':
				i++
				terminated = true
			case '\x9c':
				i++
				terminated = true
			case '\x1b':
				if i+1 < len(content) && content[i+1] == '\\' {
					i += 2
					terminated = true
				}
			}
			if terminated {
				break
			}
			i++
		}

		if !terminated {
			out.WriteString(content[start:])
			break
		}
	}

	return out.String()
}

// kill terminates the tmux session.
func (s *Session) kill() error {
	defer s.stopCapture()
	panePIDs := s.listPanePIDs()

	// First, ask the foreground program/shell to exit gracefully so agents can
	// flush final output (resume tokens, status lines, etc.) before the session
	// is torn down.
	if err := s.requestGracefulExit(); err != nil && s.isAlive() {
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

func (s *Session) requestGracefulExit() error {
	if !s.isAlive() {
		return nil
	}

	if isShell, err := s.isForegroundShell(); err == nil && isShell {
		// Only send literal "exit" when the foreground program is a shell, so
		// we do not inject text into editors or other interactive programs.
		if err := s.sendLiteral("exit"); err != nil && s.livenessStatus() == sessionLivenessAlive {
			return err
		}
		if err := s.sendKeys("Enter"); err != nil && s.livenessStatus() == sessionLivenessAlive {
			return err
		}
		if s.waitForExit(gracefulExitWait, 100*time.Millisecond) {
			return nil
		}
	}

	// Interrupt first so interactive foreground programs can flush/stop before
	// we fall back to EOF semantics.
	if s.isAlive() {
		if err := s.sendKeys("C-c"); err != nil && s.livenessStatus() == sessionLivenessAlive {
			return err
		}
		time.Sleep(150 * time.Millisecond)
	}

	// One EOF fallback helps when the foreground shell/program is waiting for
	// end-of-input, without aggressively tearing through nested shells.
	if s.isAlive() {
		if err := s.sendKeys("C-d"); err != nil && s.livenessStatus() == sessionLivenessAlive {
			return err
		}
		if s.waitForExit(gracefulExitWait, 100*time.Millisecond) {
			return nil
		}
	}

	return nil
}

func (s *Session) isForegroundShell() (bool, error) {
	out, err := exec.Command("tmux", "display-message", "-t", s.tmuxName, "-p", "#{pane_current_command}").Output()
	if err != nil {
		return false, err
	}
	return isShellCommand(string(out)), nil
}

func isShellCommand(cmd string) bool {
	switch strings.ToLower(filepath.Base(strings.TrimSpace(cmd))) {
	case "sh", "bash", "zsh", "dash", "fish", "ksh", "ash":
		return true
	default:
		return false
	}
}

func (s *Session) killTmuxSession() error {
	cmd := exec.Command("tmux", "kill-session", "-t", s.tmuxName)
	if out, err := cmd.CombinedOutput(); err != nil {
		if s.livenessStatus() != sessionLivenessAlive {
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
	return s.livenessStatus() != sessionLivenessGone
}

func (s *Session) livenessStatus() sessionLiveness {
	out, err := exec.Command("tmux", "has-session", "-t", s.tmuxName).CombinedOutput()
	if err == nil {
		return sessionLivenessAlive
	}
	return sessionLivenessFromHasSessionOutput(out)
}

func sessionLivenessFromHasSessionOutput(out []byte) sessionLiveness {
	lowOut := strings.ToLower(string(out))
	switch {
	case strings.Contains(lowOut, "can't find session"):
		return sessionLivenessGone
	case strings.Contains(lowOut, "no server running"):
		return sessionLivenessGone
	case strings.Contains(lowOut, "failed to connect to server"),
		strings.Contains(lowOut, "connection refused"),
		strings.Contains(lowOut, "no such file or directory"):
		return sessionLivenessUnknown
	default:
		return sessionLivenessUnknown
	}
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
