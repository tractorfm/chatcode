// Package ssh manages the authorized_keys file for the vibe user.
package ssh

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// KeyEntry represents one line in authorized_keys.
type KeyEntry struct {
	Fingerprint string
	Algorithm   string
	Label       string
	PublicKey   string // full line as stored
	ExpiresAt   *time.Time
}

// Manager handles authorized_keys CRUD.
type Manager struct {
	mu      sync.Mutex
	keyFile string
}

// NewManager creates a Manager for the given authorized_keys file.
func NewManager(keyFile string) *Manager {
	return &Manager{keyFile: keyFile}
}

// Authorize appends a public key with an optional expiry comment.
// The stored line format: <algorithm> <base64-key> vibecode:<label>[:<expiry-unix>]
// Any existing comment in publicKey is discarded.
func (m *Manager) Authorize(publicKey, label string, expiresAt *time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Parse and validate the public key, extracting just the key material.
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(publicKey))
	if err != nil {
		return fmt.Errorf("invalid public key: %w", err)
	}

	// Reconstruct the line using only algorithm + key material + our comment.
	// ssh.MarshalAuthorizedKey produces "<alg> <b64>\n" (no comment); we trim the newline.
	keyLine := strings.TrimRight(string(ssh.MarshalAuthorizedKey(pub)), "\n")
	comment := buildComment(label, expiresAt)
	line := keyLine + " " + comment + "\n"

	f, err := os.OpenFile(m.keyFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open authorized_keys: %w", err)
	}
	defer f.Close()
	_, err = f.WriteString(line)
	return err
}

// Revoke removes the key matching the given fingerprint (SHA-256 hex).
func (m *Manager) Revoke(fingerprint string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rewriteExcluding(func(e KeyEntry) bool {
		return e.Fingerprint != fingerprint
	})
}

// List parses authorized_keys and returns all entries.
func (m *Manager) List() ([]KeyEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.readEntries()
}

// RemoveExpired removes all entries whose expiry time is in the past.
func (m *Manager) RemoveExpired() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	return m.rewriteExcluding(func(e KeyEntry) bool {
		return e.ExpiresAt == nil || e.ExpiresAt.After(now)
	})
}

// readEntries parses the authorized_keys file without holding the lock.
// Caller must hold m.mu.
func (m *Manager) readEntries() ([]KeyEntry, error) {
	f, err := os.Open(m.keyFile)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open authorized_keys: %w", err)
	}
	defer f.Close()

	var entries []KeyEntry
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		entry, err := parseLine(line)
		if err != nil {
			continue // skip malformed lines
		}
		entries = append(entries, entry)
	}
	return entries, scanner.Err()
}

// rewriteExcluding rewrites the file keeping only lines for which keep returns true.
// Caller must hold m.mu.
func (m *Manager) rewriteExcluding(keep func(KeyEntry) bool) error {
	entries, err := m.readEntries()
	if err != nil {
		return err
	}

	// Build new content from kept entries
	var kept []string
	for _, e := range entries {
		if keep(e) {
			kept = append(kept, e.PublicKey)
		}
	}

	content := strings.Join(kept, "\n")
	if len(kept) > 0 {
		content += "\n"
	}
	return os.WriteFile(m.keyFile, []byte(content), 0o600)
}

// parseLine extracts a KeyEntry from one authorized_keys line.
func parseLine(line string) (KeyEntry, error) {
	pub, comment, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil {
		return KeyEntry{}, err
	}

	fp := fingerprintSHA256(pub)
	label, expiresAt := parseComment(comment)

	return KeyEntry{
		Fingerprint: fp,
		Algorithm:   pub.Type(),
		Label:       label,
		PublicKey:   line,
		ExpiresAt:   expiresAt,
	}, nil
}

// buildComment creates the comment field: vibecode:<label>[:<expiry-unix>]
func buildComment(label string, expiresAt *time.Time) string {
	if expiresAt != nil {
		return fmt.Sprintf("vibecode:%s:%d", label, expiresAt.Unix())
	}
	return "vibecode:" + label
}

// parseComment extracts label and optional expiry from a vibecode comment.
func parseComment(comment string) (label string, expiresAt *time.Time) {
	if !strings.HasPrefix(comment, "vibecode:") {
		return comment, nil
	}
	rest := strings.TrimPrefix(comment, "vibecode:")
	parts := strings.SplitN(rest, ":", 2)
	label = parts[0]
	if len(parts) == 2 {
		var unix int64
		if _, err := fmt.Sscanf(parts[1], "%d", &unix); err == nil {
			t := time.Unix(unix, 0)
			expiresAt = &t
		}
	}
	return label, expiresAt
}

// fingerprintSHA256 returns the SHA-256 fingerprint in the format "SHA256:base64".
func fingerprintSHA256(pub ssh.PublicKey) string {
	h := sha256.Sum256(pub.Marshal())
	return "SHA256:" + base64.StdEncoding.EncodeToString(h[:])
}
