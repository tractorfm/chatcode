// Package session manages tmux-backed PTY sessions.
package session

import (
	"fmt"
	"sync"
)

// Manager tracks active sessions and enforces the per-VPS limit.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	maxCount int
}

// NewManager creates a Manager with the given session limit.
func NewManager(maxSessions int) *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
		maxCount: maxSessions,
	}
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
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("session %q not found", sessionID)
	}
	return s.kill()
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

// Remove is called internally when a session exits on its own.
func (m *Manager) remove(sessionID string) {
	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()
}
