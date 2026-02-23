// Package update implements self-update for the gateway binary.
//
// Update flow:
//  1. Download new binary to <binaryPath>.new
//  2. Verify SHA-256 checksum
//  3. Rename current binary to <binaryPath>.prev
//  4. Rename .new to current binary path
//  5. Signal systemd to restart the service
//
// On failure: restore .prev → current (rollback).
package update

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"time"
)

const downloadTimeout = 5 * time.Minute

// Updater performs gateway self-updates.
type Updater struct {
	binaryPath string
	log        *slog.Logger
}

// NewUpdater creates an Updater. binaryPath is the path to the running binary
// (from config or os.Executable()).
func NewUpdater(binaryPath string, log *slog.Logger) *Updater {
	return &Updater{
		binaryPath: binaryPath,
		log:        log,
	}
}

// Update downloads the binary at url, verifies its SHA-256, swaps binaries,
// and triggers a systemd restart. The function returns after initiating the
// restart – the process will be replaced by systemd shortly after.
func (u *Updater) Update(url, expectedSHA256 string) error {
	newPath := u.binaryPath + ".new"
	prevPath := u.binaryPath + ".prev"

	u.log.Info("starting self-update", "url", url)

	// 1. Download
	if err := u.download(url, newPath); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer func() {
		// Clean up .new on any failure before rename
		os.Remove(newPath)
	}()

	// 2. Verify checksum
	if err := verifySHA256(newPath, expectedSHA256); err != nil {
		return fmt.Errorf("checksum verification failed: %w", err)
	}

	// 3. Make new binary executable
	if err := os.Chmod(newPath, 0o755); err != nil {
		return fmt.Errorf("chmod new binary: %w", err)
	}

	// 4. Backup current binary
	if err := os.Rename(u.binaryPath, prevPath); err != nil {
		return fmt.Errorf("backup current binary: %w", err)
	}

	// 5. Promote new binary
	if err := os.Rename(newPath, u.binaryPath); err != nil {
		// Rollback
		u.log.Error("rename failed, rolling back", "err", err)
		if rbErr := os.Rename(prevPath, u.binaryPath); rbErr != nil {
			u.log.Error("rollback also failed", "err", rbErr)
		}
		return fmt.Errorf("promote new binary: %w", err)
	}

	u.log.Info("binary replaced, triggering systemd restart")

	// 6. Restart via systemd (non-blocking – this process will be killed)
	if err := exec.Command("systemctl", "restart", "chatcode-gateway").Start(); err != nil {
		u.log.Warn("systemctl restart failed (may not be running under systemd)", "err", err)
	}

	return nil
}

// download fetches url and saves it to dest.
func (u *Updater) download(url, dest string) error {
	client := &http.Client{Timeout: downloadTimeout}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	return err
}

// verifySHA256 checks that the file at path has the expected SHA-256 hex digest.
func verifySHA256(path, expected string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != expected {
		return fmt.Errorf("checksum mismatch: got %s, want %s", got, expected)
	}
	return nil
}
