// Package files implements file upload and download over the WebSocket protocol.
//
// Upload flow: file.upload.begin → N×file.upload.chunk → file.upload.end
// Download flow: file.download → gateway sends file.content.begin + chunks + end
package files

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	maxFileSize = 20 * 1024 * 1024 // 20MB
	chunkSize   = 128 * 1024       // 128KB
	transferTTL = 5 * time.Minute
)

// UploadState tracks an in-progress file upload.
type UploadState struct {
	TransferID  string
	DestPath    string
	TotalChunks int
	Received    int
	TempFile    *os.File
	CreatedAt   time.Time
}

// ChunkEvent carries a download chunk to the WebSocket sender.
type ChunkEvent struct {
	Type        string `json:"type"`
	TransferID  string `json:"transfer_id"`
	Seq         int    `json:"seq,omitempty"`
	Data        string `json:"data,omitempty"` // base64
	Path        string `json:"path,omitempty"`
	Size        int64  `json:"size,omitempty"`
	TotalChunks int    `json:"total_chunks,omitempty"`
}

// Sender is a callback to push JSON frames over the WebSocket.
type Sender func(ctx context.Context, v any) error

// Handler manages file transfers.
type Handler struct {
	tempDir       string
	workspaceRoot string
	sender        Sender

	mu      sync.Mutex
	uploads map[string]*UploadState
}

// NewHandler creates a Handler.
// tempDir must be writable; workspaceRoot constrains upload/download paths.
func NewHandler(tempDir, workspaceRoot string, sender Sender) *Handler {
	root := filepath.Clean(workspaceRoot)
	if !filepath.IsAbs(root) {
		if abs, err := filepath.Abs(root); err == nil {
			root = abs
		}
	}
	return &Handler{
		tempDir:       tempDir,
		workspaceRoot: root,
		sender:        sender,
		uploads:       make(map[string]*UploadState),
	}
}

// UploadBegin initialises a new upload transfer.
func (h *Handler) UploadBegin(transferID, destPath string, size int64, totalChunks int) error {
	if size > maxFileSize {
		return fmt.Errorf("file too large: %d bytes (max %d)", size, maxFileSize)
	}
	safeDestPath, err := h.resolveWorkspacePath(destPath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(h.tempDir, 0o755); err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}

	tmp, err := os.CreateTemp(h.tempDir, "upload-"+transferID+"-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}

	h.mu.Lock()
	h.uploads[transferID] = &UploadState{
		TransferID:  transferID,
		DestPath:    safeDestPath,
		TotalChunks: totalChunks,
		TempFile:    tmp,
		CreatedAt:   time.Now(),
	}
	h.mu.Unlock()
	return nil
}

// UploadChunk writes a base64-encoded chunk to the temp file.
func (h *Handler) UploadChunk(transferID string, seq int, data string) error {
	h.mu.Lock()
	state, ok := h.uploads[transferID]
	h.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown transfer %q", transferID)
	}

	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return fmt.Errorf("decode chunk: %w", err)
	}

	if _, err := state.TempFile.Write(raw); err != nil {
		return fmt.Errorf("write chunk: %w", err)
	}

	h.mu.Lock()
	state.Received++
	h.mu.Unlock()
	return nil
}

// UploadEnd moves the temp file to its destination.
func (h *Handler) UploadEnd(transferID string) error {
	h.mu.Lock()
	state, ok := h.uploads[transferID]
	if ok {
		delete(h.uploads, transferID)
	}
	h.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown transfer %q", transferID)
	}

	tmpPath := state.TempFile.Name()
	state.TempFile.Close()

	// Ensure destination directory exists
	if err := os.MkdirAll(filepath.Dir(state.DestPath), 0o755); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("create dest dir: %w", err)
	}

	if err := os.Rename(tmpPath, state.DestPath); err != nil {
		// Cross-device rename: copy then delete
		if copyErr := copyFile(tmpPath, state.DestPath); copyErr != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("move file: %w (copy also failed: %v)", err, copyErr)
		}
		os.Remove(tmpPath)
	}
	return nil
}

// Cancel aborts an in-progress upload.
func (h *Handler) Cancel(transferID string) {
	h.mu.Lock()
	state, ok := h.uploads[transferID]
	if ok {
		delete(h.uploads, transferID)
	}
	h.mu.Unlock()
	if ok {
		state.TempFile.Close()
		os.Remove(state.TempFile.Name())
	}
}

// Download reads a file and sends it back as file.content.* events.
func (h *Handler) Download(ctx context.Context, transferID, path string) error {
	safePath, err := h.resolveWorkspacePath(path)
	if err != nil {
		return err
	}

	f, err := os.Open(safePath)
	if err != nil {
		return fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat file: %w", err)
	}
	if info.Size() > maxFileSize {
		return fmt.Errorf("file too large: %d bytes", info.Size())
	}

	totalChunks := int((info.Size() + int64(chunkSize) - 1) / int64(chunkSize))

	if err := h.sender(ctx, ChunkEvent{
		Type:        "file.content.begin",
		TransferID:  transferID,
		Path:        safePath,
		Size:        info.Size(),
		TotalChunks: totalChunks,
	}); err != nil {
		return err
	}

	buf := make([]byte, chunkSize)
	seq := 0
	for {
		n, err := f.Read(buf)
		if n > 0 {
			chunk := ChunkEvent{
				Type:       "file.content.chunk",
				TransferID: transferID,
				Seq:        seq,
				Data:       base64.StdEncoding.EncodeToString(buf[:n]),
			}
			if sendErr := h.sender(ctx, chunk); sendErr != nil {
				return sendErr
			}
			seq++
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read file: %w", err)
		}
	}

	return h.sender(ctx, ChunkEvent{
		Type:       "file.content.end",
		TransferID: transferID,
	})
}

// PruneStale removes uploads that exceeded the transfer TTL.
func (h *Handler) PruneStale() {
	cutoff := time.Now().Add(-transferTTL)
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, state := range h.uploads {
		if state.CreatedAt.Before(cutoff) {
			state.TempFile.Close()
			os.Remove(state.TempFile.Name())
			delete(h.uploads, id)
		}
	}
}

func copyFile(src, dst string) error {
	s, err := os.Open(src)
	if err != nil {
		return err
	}
	defer s.Close()

	d, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer d.Close()

	_, err = io.Copy(d, s)
	return err
}

func (h *Handler) resolveWorkspacePath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("path is required")
	}

	p := filepath.Clean(path)
	if !filepath.IsAbs(p) {
		p = filepath.Join(h.workspaceRoot, p)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("resolve path %q: %w", path, err)
	}

	rel, err := filepath.Rel(h.workspaceRoot, abs)
	if err != nil {
		return "", fmt.Errorf("check path %q: %w", path, err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q escapes workspace root", path)
	}

	return abs, nil
}
