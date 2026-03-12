// Package session manages tmux-backed PTY sessions.
package session

import (
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Manager tracks active sessions and enforces the per-VPS limit.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	maxCount int

	checkInterval             time.Duration
	isAlive                   func(*Session) bool
	livenessStatus            func(*Session) sessionLiveness
	endSession                func(*Session) error
	onSessionExit             func(string)
	listRecoverableSessionIDs func() ([]string, error)
	newRecoveredSession       func(string, chan OutputChunk) *Session
}

// NewManager creates a Manager with the given session limit.
func NewManager(maxSessions int) *Manager {
	return &Manager{
		sessions:      make(map[string]*Session),
		maxCount:      maxSessions,
		checkInterval: 1 * time.Second,
		isAlive: func(s *Session) bool {
			return s.isAlive()
		},
		livenessStatus: func(s *Session) sessionLiveness {
			return s.livenessStatus()
		},
		endSession: func(s *Session) error {
			return s.kill()
		},
		listRecoverableSessionIDs: listRecoverableSessionIDs,
		newRecoveredSession:       newRecoveredSession,
	}
}

// SetOnSessionExit registers a callback fired when a tracked session exits on
// its own and is removed by the watcher loop.
func (m *Manager) SetOnSessionExit(fn func(string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onSessionExit = fn
}

// Create creates and starts a new session. Returns an error if the limit is
// reached or a session with the same ID already exists.
func (m *Manager) Create(opts Options) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.sessions[opts.SessionID]; exists {
		return nil, fmt.Errorf("session %q already exists", opts.SessionID)
	}
	if len(m.sessions) >= m.maxCount {
		return nil, fmt.Errorf("session limit reached (%d)", m.maxCount)
	}

	s := newSession(opts)
	if err := s.start(); err != nil {
		return nil, fmt.Errorf("start session %q: %w", opts.SessionID, err)
	}
	m.sessions[opts.SessionID] = s
	go m.watchSession(opts.SessionID, s)
	return s, nil
}

// Get returns the session by ID or nil.
func (m *Manager) Get(sessionID string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[sessionID]
}

// End kills a session and removes it from the manager.
func (m *Manager) End(sessionID string) error {
	m.mu.RLock()
	s, ok := m.sessions[sessionID]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("session %q not found", sessionID)
	}
	if err := m.endSession(s); err != nil {
		return err
	}

	m.mu.Lock()
	current, exists := m.sessions[sessionID]
	if exists && current == s {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()
	return nil
}

// List returns summaries of all active sessions.
func (m *Manager) List() []Summary {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Summary, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s.Summary())
	}
	return out
}

// Recover discovers existing tmux-backed sessions and re-attaches them to the in-memory manager.
// This is used on gateway process restart so user sessions survive daemon restarts.
func (m *Manager) Recover(outputCh chan OutputChunk) ([]string, error) {
	sessionIDs, err := m.listRecoverableSessionIDs()
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	recovered := make([]string, 0, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		if _, exists := m.sessions[sessionID]; exists {
			continue
		}

		s := m.newRecoveredSession(sessionID, outputCh)
		m.sessions[sessionID] = s
		recovered = append(recovered, sessionID)
		go m.watchSession(sessionID, s)
	}

	return recovered, nil
}

// Remove is called internally when a session exits on its own.
func (m *Manager) remove(sessionID string) {
	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()
}

func (m *Manager) watchSession(sessionID string, s *Session) {
	ticker := time.NewTicker(m.checkInterval)
	defer ticker.Stop()
	goneChecks := 0

	for range ticker.C {
		m.mu.RLock()
		current, ok := m.sessions[sessionID]
		m.mu.RUnlock()
		if !ok || current != s {
			return
		}
		state := sessionLivenessAlive
		switch {
		case m.livenessStatus != nil:
			state = m.livenessStatus(s)
		case m.isAlive != nil && !m.isAlive(s):
			state = sessionLivenessGone
		}
		switch state {
		case sessionLivenessAlive:
			goneChecks = 0
			continue
		case sessionLivenessUnknown:
			goneChecks = 0
			continue
		case sessionLivenessGone:
			goneChecks++
		}
		if goneChecks >= 2 {
			m.mu.Lock()
			current, ok := m.sessions[sessionID]
			onExit := m.onSessionExit
			if ok && current == s {
				delete(m.sessions, sessionID)
			}
			m.mu.Unlock()
			s.stopCapture()
			if ok && current == s && onExit != nil {
				onExit(sessionID)
			}
			return
		}
	}
}

func newRecoveredSession(sessionID string, outputCh chan OutputChunk) *Session {
	s := &Session{
		opts: Options{
			SessionID: sessionID,
			Name:      sessionID,
			OutputCh:  outputCh,
		},
		tmuxName: "vibe-" + sessionID,
	}
	s.capturer = newOutputCapturer(s.tmuxName, s.opts.SessionID, &s.seq, &s.lastActivityAt, s.opts.OutputCh)
	s.capturer.start()
	atomic.StoreInt64(&s.lastActivityAt, time.Now().UnixNano())
	return s
}

func listRecoverableSessionIDs() ([]string, error) {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").CombinedOutput()
	if err != nil {
		// No tmux server means no running sessions to recover.
		lowOut := strings.ToLower(string(out))
		if strings.Contains(lowOut, "no server running") || strings.Contains(lowOut, "failed to connect to server") {
			return nil, nil
		}
		return nil, fmt.Errorf("list tmux sessions: %w: %s", err, strings.TrimSpace(string(out)))
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	ids := make([]string, 0, len(lines))
	for _, line := range lines {
		name := strings.TrimSpace(line)
		if !strings.HasPrefix(name, "vibe-ses-") {
			continue
		}
		id := strings.TrimPrefix(name, "vibe-")
		if id == "" {
			continue
		}
		ids = append(ids, id)
	}
	return ids, nil
}
