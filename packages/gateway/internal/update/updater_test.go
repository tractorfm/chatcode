package update

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestUpdateSuccess(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "gateway")
	oldContent := []byte("old-binary")
	newContent := []byte("new-binary")
	mustWriteFile(t, binaryPath, oldContent)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(newContent)
	}))
	defer srv.Close()

	u := NewUpdater(binaryPath, discardLogger())
	u.restartFn = func() error { return nil }

	if err := u.Update(srv.URL, sha256Hex(newContent)); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got := mustReadFile(t, binaryPath)
	if string(got) != string(newContent) {
		t.Fatalf("binary content = %q, want %q", string(got), string(newContent))
	}

	prev := mustReadFile(t, binaryPath+".prev")
	if string(prev) != string(oldContent) {
		t.Fatalf("prev content = %q, want %q", string(prev), string(oldContent))
	}
}

func TestUpdateRollbackOnRestartFailure(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "gateway")
	oldContent := []byte("old-binary")
	newContent := []byte("new-binary")
	mustWriteFile(t, binaryPath, oldContent)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(newContent)
	}))
	defer srv.Close()

	u := NewUpdater(binaryPath, discardLogger())
	u.restartFn = func() error { return errors.New("restart failed") }

	err := u.Update(srv.URL, sha256Hex(newContent))
	if err == nil {
		t.Fatal("expected restart failure")
	}

	got := mustReadFile(t, binaryPath)
	if string(got) != string(oldContent) {
		t.Fatalf("binary content after rollback = %q, want %q", string(got), string(oldContent))
	}
}

func TestUpdateChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "gateway")
	oldContent := []byte("old-binary")
	newContent := []byte("new-binary")
	mustWriteFile(t, binaryPath, oldContent)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(newContent)
	}))
	defer srv.Close()

	u := NewUpdater(binaryPath, discardLogger())
	u.restartFn = func() error {
		t.Fatal("restart should not run on checksum failure")
		return nil
	}

	err := u.Update(srv.URL, sha256Hex([]byte("wrong")))
	if err == nil {
		t.Fatal("expected checksum failure")
	}

	got := mustReadFile(t, binaryPath)
	if string(got) != string(oldContent) {
		t.Fatalf("binary content = %q, want %q", string(got), string(oldContent))
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func mustWriteFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o755); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	return data
}
