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
	"runtime"
	"testing"
)

func stubLinuxUpdate(t *testing.T, u *Updater) {
	t.Helper()
	if runtime.GOOS != "linux" {
		return
	}
	u.installFn = func(src, dst string) error {
		data, err := os.ReadFile(src)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, data, 0o755)
	}
	u.rollbackFn = u.installFn
}

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
	stubLinuxUpdate(t, u)
	u.restartFn = func() error { return nil }

	if err := u.Update(srv.URL, sha256Hex(newContent)); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got := mustReadFile(t, binaryPath)
	if string(got) != string(newContent) {
		t.Fatalf("binary content = %q, want %q", string(got), string(newContent))
	}

	if runtime.GOOS != "linux" {
		prev := mustReadFile(t, binaryPath+".prev")
		if string(prev) != string(oldContent) {
			t.Fatalf("prev content = %q, want %q", string(prev), string(oldContent))
		}
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
	stubLinuxUpdate(t, u)
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
	stubLinuxUpdate(t, u)
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

func TestUpdateReleaseResolvesRuntimeArtifact(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "gateway")
	oldContent := []byte("old-binary")
	newContent := []byte("new-binary")
	mustWriteFile(t, binaryPath, oldContent)

	objectName, err := releaseObjectName(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Skipf("unsupported test target: %v", err)
	}
	checksums := sha256Hex(newContent) + "  " + objectName + "\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gateway/v9.9.9/checksums.txt":
			_, _ = w.Write([]byte(checksums))
		case "/gateway/v9.9.9/" + objectName:
			_, _ = w.Write(newContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	u := NewUpdater(binaryPath, discardLogger())
	stubLinuxUpdate(t, u)
	u.restartFn = func() error { return nil }

	if err := u.UpdateRelease(srv.URL+"/gateway", "v9.9.9"); err != nil {
		t.Fatalf("UpdateRelease: %v", err)
	}

	got := mustReadFile(t, binaryPath)
	if string(got) != string(newContent) {
		t.Fatalf("binary content = %q, want %q", string(got), string(newContent))
	}
}

func TestTempArtifactPathPrefersChatcodeTmpDir(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(t.TempDir(), "gateway")
	u := NewUpdater(binaryPath, discardLogger())

	t.Setenv(chatcodeTmpDirEnv, dir)
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "tmpdir-unused"))

	path, err := u.tempArtifactPath("gateway-new-")
	if err != nil {
		t.Fatalf("tempArtifactPath: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })

	if filepath.Dir(path) != dir {
		t.Fatalf("temp artifact dir = %q, want %q", filepath.Dir(path), dir)
	}
}

func TestTempArtifactPathFallsBackWhenTmpdirUnavailable(t *testing.T) {
	binaryPath := filepath.Join(t.TempDir(), "gateway")
	u := NewUpdater(binaryPath, discardLogger())

	t.Setenv(chatcodeTmpDirEnv, "/proc/chatcode-nope")
	t.Setenv("TMPDIR", "/proc/chatcode-nope")

	path, err := u.tempArtifactPath("gateway-new-")
	if err != nil {
		t.Fatalf("tempArtifactPath: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })

	dir := filepath.Dir(path)
	if dir != "/var/tmp" && dir != filepath.Dir(binaryPath) {
		t.Fatalf("temp artifact dir = %q, want fallback in /var/tmp or binary dir", dir)
	}
}

func TestReleaseObjectNameRejectsUnsupportedTarget(t *testing.T) {
	if _, err := releaseObjectName("linux", "386"); err == nil {
		t.Fatal("expected unsupported target error")
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
