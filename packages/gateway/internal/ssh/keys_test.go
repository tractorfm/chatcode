package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	gossh "golang.org/x/crypto/ssh"
)

// generateTestKey returns an authorized_keys line for a fresh Ed25519 key.
func generateTestKey(t *testing.T, comment string) string {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	pub, err := gossh.NewPublicKey(priv.Public())
	if err != nil {
		t.Fatalf("encode public key: %v", err)
	}
	return string(gossh.MarshalAuthorizedKey(pub))[:len(string(gossh.MarshalAuthorizedKey(pub)))-1] + " " + comment
}

func tempKeyFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "authorized_keys")
}

func TestAuthorize(t *testing.T) {
	f := tempKeyFile(t)
	m := NewManager(f)
	key := generateTestKey(t, "test@example.com")

	if err := m.Authorize(key, "my-laptop", nil); err != nil {
		t.Fatalf("Authorize: %v", err)
	}

	entries, err := m.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Label != "my-laptop" {
		t.Errorf("label = %q, want 'my-laptop'", entries[0].Label)
	}
	if entries[0].ExpiresAt != nil {
		t.Errorf("expected no expiry, got %v", entries[0].ExpiresAt)
	}
}

func TestAuthorizeWithExpiry(t *testing.T) {
	f := tempKeyFile(t)
	m := NewManager(f)
	key := generateTestKey(t, "test@example.com")

	exp := time.Now().Add(24 * time.Hour).Truncate(time.Second)
	if err := m.Authorize(key, "temp-key", &exp); err != nil {
		t.Fatalf("Authorize: %v", err)
	}

	entries, err := m.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].ExpiresAt == nil {
		t.Fatal("expected expiry to be set")
	}
	if !entries[0].ExpiresAt.Equal(exp) {
		t.Errorf("expiry = %v, want %v", entries[0].ExpiresAt, exp)
	}
}

func TestRevoke(t *testing.T) {
	f := tempKeyFile(t)
	m := NewManager(f)
	key1 := generateTestKey(t, "key1@example.com")
	key2 := generateTestKey(t, "key2@example.com")

	m.Authorize(key1, "key1", nil)
	m.Authorize(key2, "key2", nil)

	entries, _ := m.List()
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}

	fp := entries[0].Fingerprint
	if err := m.Revoke(fp); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	entries, _ = m.List()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry after revoke, got %d", len(entries))
	}
	if entries[0].Fingerprint == fp {
		t.Error("revoked key still present")
	}
}

func TestListEmptyFile(t *testing.T) {
	f := tempKeyFile(t)
	m := NewManager(f)
	entries, err := m.List()
	if err != nil {
		t.Fatalf("List on missing file: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected 0 entries, got %d", len(entries))
	}
}

func TestRemoveExpired(t *testing.T) {
	f := tempKeyFile(t)
	m := NewManager(f)
	key1 := generateTestKey(t, "key1@example.com")
	key2 := generateTestKey(t, "key2@example.com")

	past := time.Now().Add(-1 * time.Hour)
	future := time.Now().Add(1 * time.Hour)

	m.Authorize(key1, "expired-key", &past)
	m.Authorize(key2, "valid-key", &future)

	if err := m.RemoveExpired(); err != nil {
		t.Fatalf("RemoveExpired: %v", err)
	}

	entries, _ := m.List()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry after expiry removal, got %d", len(entries))
	}
	if entries[0].Label != "valid-key" {
		t.Errorf("wrong key kept: %q", entries[0].Label)
	}
}

func TestBuildParseComment(t *testing.T) {
	exp := time.Unix(1700000000, 0)
	comment := buildComment("my-key", &exp)
	label, got := parseComment(comment)
	if label != "my-key" {
		t.Errorf("label = %q, want 'my-key'", label)
	}
	if got == nil || !got.Equal(exp) {
		t.Errorf("expiry = %v, want %v", got, exp)
	}
}

func TestInvalidKeyRejected(t *testing.T) {
	f := tempKeyFile(t)
	m := NewManager(f)
	err := m.Authorize("not-a-public-key", "bad", nil)
	if err == nil {
		t.Fatal("expected error for invalid key")
	}
	// File should not have been written
	if _, err := os.Stat(f); !os.IsNotExist(err) {
		t.Error("expected file to not exist after invalid key")
	}
}
