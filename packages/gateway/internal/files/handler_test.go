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
	destDir := t.TempDir()

	var sent []ChunkEvent
	sender := func(ctx context.Context, v any) error {
		if e, ok := v.(ChunkEvent); ok {
			sent = append(sent, e)
		}
		return nil
	}

	h := NewHandler(tmpDir, sender)
	ctx := context.Background()

	// Upload a file
	content := []byte("hello vibecode file transfer test")
	encoded := base64.StdEncoding.EncodeToString(content)
	destPath := filepath.Join(destDir, "test.txt")

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
	h := NewHandler(tmpDir, func(_ context.Context, _ any) error { return nil })

	h.UploadBegin("cancel-test", "/tmp/nowhere", 100, 1)
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
	h := NewHandler(t.TempDir(), func(_ context.Context, _ any) error { return nil })
	err := h.UploadBegin("big", "/tmp/big", maxFileSize+1, 1)
	if err == nil {
		t.Fatal("expected error for oversized file")
	}
}

func TestDownloadNonExistentFile(t *testing.T) {
	h := NewHandler(t.TempDir(), func(_ context.Context, _ any) error { return nil })
	err := h.Download(context.Background(), "t1", "/nonexistent/path/file.txt")
	if err == nil {
		t.Fatal("expected error for nonexistent file")
	}
}
