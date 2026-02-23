package files

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestUploadDownloadRoundtrip(t *testing.T) {
	tmpDir := t.TempDir()
	workspace := t.TempDir()

	var sent []ChunkEvent
	sender := func(ctx context.Context, v any) error {
		if e, ok := v.(ChunkEvent); ok {
			sent = append(sent, e)
		}
		return nil
	}

	h := NewHandler(tmpDir, workspace, sender)
	ctx := context.Background()

	// Upload a file
	content := []byte("hello vibecode file transfer test")
	encoded := base64.StdEncoding.EncodeToString(content)
	destPath := filepath.Join(workspace, "test.txt")

	if err := h.UploadBegin("t1", destPath, int64(len(content)), 1); err != nil {
		t.Fatalf("UploadBegin: %v", err)
	}
	if err := h.UploadChunk("t1", 0, encoded); err != nil {
		t.Fatalf("UploadChunk: %v", err)
	}
	if err := h.UploadEnd("t1"); err != nil {
		t.Fatalf("UploadEnd: %v", err)
	}

	// Verify file was written
	got, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("ReadFile after upload: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("file content = %q, want %q", got, content)
	}

	// Download the same file
	sent = nil
	if err := h.Download(ctx, "t2", destPath); err != nil {
		t.Fatalf("Download: %v", err)
	}

	// Verify events
	if len(sent) < 3 {
		t.Fatalf("expected at least 3 events (begin/chunk/end), got %d", len(sent))
	}
	if sent[0].Type != "file.content.begin" {
		t.Errorf("first event type = %q", sent[0].Type)
	}
	if sent[len(sent)-1].Type != "file.content.end" {
		t.Errorf("last event type = %q", sent[len(sent)-1].Type)
	}

	// Reconstruct downloaded content
	var downloaded []byte
	for _, e := range sent {
		if e.Type == "file.content.chunk" {
			raw, err := base64.StdEncoding.DecodeString(e.Data)
			if err != nil {
				t.Fatalf("decode chunk: %v", err)
			}
			downloaded = append(downloaded, raw...)
		}
	}
	if string(downloaded) != string(content) {
		t.Errorf("downloaded = %q, want %q", downloaded, content)
	}
}

func TestUploadCancel(t *testing.T) {
	tmpDir := t.TempDir()
	workspace := t.TempDir()
	h := NewHandler(tmpDir, workspace, func(_ context.Context, _ any) error { return nil })

	h.UploadBegin("cancel-test", filepath.Join(workspace, "nowhere"), 100, 1)
	h.Cancel("cancel-test")

	// Verify temp file was cleaned up (there should be nothing in tmpDir from this transfer)
	entries, _ := os.ReadDir(tmpDir)
	for _, e := range entries {
		if !e.IsDir() {
			// Temp files should have been deleted
			t.Errorf("unexpected file in tmpDir after cancel: %s", e.Name())
		}
	}
}

func TestFileTooLarge(t *testing.T) {
	workspace := t.TempDir()
	h := NewHandler(t.TempDir(), workspace, func(_ context.Context, _ any) error { return nil })
	err := h.UploadBegin("big", filepath.Join(workspace, "big"), maxFileSize+1, 1)
	if err == nil {
		t.Fatal("expected error for oversized file")
	}
}

func TestDownloadNonExistentFile(t *testing.T) {
	workspace := t.TempDir()
	h := NewHandler(t.TempDir(), workspace, func(_ context.Context, _ any) error { return nil })
	err := h.Download(context.Background(), "t1", filepath.Join(workspace, "does-not-exist.txt"))
	if err == nil {
		t.Fatal("expected error for nonexistent file")
	}
}

func TestUploadBeginRejectsPathOutsideWorkspace(t *testing.T) {
	workspace := t.TempDir()
	otherDir := t.TempDir()
	h := NewHandler(t.TempDir(), workspace, func(_ context.Context, _ any) error { return nil })

	err := h.UploadBegin("escape", filepath.Join(otherDir, "outside.txt"), 1, 1)
	if err == nil {
		t.Fatal("expected path escape error")
	}
}

func TestDownloadRejectsPathOutsideWorkspace(t *testing.T) {
	workspace := t.TempDir()
	otherDir := t.TempDir()
	otherPath := filepath.Join(otherDir, "outside.txt")
	if err := os.WriteFile(otherPath, []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	h := NewHandler(t.TempDir(), workspace, func(_ context.Context, _ any) error { return nil })
	err := h.Download(context.Background(), "t1", otherPath)
	if err == nil {
		t.Fatal("expected path escape error")
	}
}

func TestUploadBeginAcceptsRelativePathInsideWorkspace(t *testing.T) {
	workspace := t.TempDir()
	h := NewHandler(t.TempDir(), workspace, func(_ context.Context, _ any) error { return nil })

	data := []byte("rel path")
	if err := h.UploadBegin("rel", "subdir/file.txt", int64(len(data)), 1); err != nil {
		t.Fatalf("UploadBegin: %v", err)
	}
	if err := h.UploadChunk("rel", 0, base64.StdEncoding.EncodeToString(data)); err != nil {
		t.Fatalf("UploadChunk: %v", err)
	}
	if err := h.UploadEnd("rel"); err != nil {
		t.Fatalf("UploadEnd: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(workspace, "subdir", "file.txt"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != string(data) {
		t.Fatalf("got %q, want %q", string(got), string(data))
	}
}
