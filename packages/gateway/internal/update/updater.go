// Package update implements self-update for the gateway binary.
//
// Update flow:
//  1. Download new binary to <binaryPath>.new
//  2. Verify SHA-256 checksum
//  3. Rename current binary to <binaryPath>.prev
//  4. Rename .new to current binary path
//  5. Restart the host service manager unit (systemd/launchd)
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
	"path/filepath"
	"runtime"
	"time"
)

const downloadTimeout = 5 * time.Minute
const (
	sudoBinary      = "/usr/bin/sudo"
	systemctlBinary = "/usr/bin/systemctl"
	installBinary   = "/usr/bin/install"
)

// Updater performs gateway self-updates.
type Updater struct {
	binaryPath string
	log        *slog.Logger
	httpClient *http.Client
	restartFn  func() error
	installFn  func(src, dst string) error
	rollbackFn func(src, dst string) error
}

// NewUpdater creates an Updater. binaryPath is the path to the running binary
// (from config or os.Executable()).
func NewUpdater(binaryPath string, log *slog.Logger) *Updater {
	u := &Updater{
		binaryPath: binaryPath,
		log:        log,
		httpClient: &http.Client{Timeout: downloadTimeout},
	}

	switch runtime.GOOS {
	case "linux":
		u.restartFn = func() error {
			return exec.Command(sudoBinary, systemctlBinary, "restart", "chatcode-gateway").Run()
		}
		u.installFn = func(src, dst string) error {
			return exec.Command(sudoBinary, installBinary, "-m", "0755", src, dst).Run()
		}
		u.rollbackFn = u.installFn
	case "darwin":
		u.restartFn = func() error {
			label := "dev.chatcode.gateway"
			uid := os.Getuid()
			targets := []string{
				fmt.Sprintf("gui/%d/%s", uid, label),
				fmt.Sprintf("user/%d/%s", uid, label),
			}
			var lastErr error
			for _, target := range targets {
				if err := exec.Command("launchctl", "kickstart", "-k", target).Run(); err == nil {
					return nil
				} else {
					lastErr = err
				}
			}
			return fmt.Errorf("launchctl kickstart failed: %w", lastErr)
		}
	default:
		u.restartFn = func() error {
			return fmt.Errorf("service restart unsupported on %s", runtime.GOOS)
		}
	}

	return u
}

// Update downloads the binary at url, verifies its SHA-256, swaps binaries,
// and triggers a service restart. The function returns after initiating the
// restart – the process will be replaced by the host service manager shortly
// after.
func (u *Updater) Update(url, expectedSHA256 string) error {
	if runtime.GOOS == "linux" {
		return u.updateWithSudo(url, expectedSHA256)
	}
	return u.updateDirect(url, expectedSHA256)
}

func (u *Updater) updateWithSudo(url, expectedSHA256 string) error {
	newPath, err := u.tempArtifactPath("gateway-new-")
	if err != nil {
		return err
	}
	prevPath, err := u.tempArtifactPath("gateway-prev-")
	if err != nil {
		os.Remove(newPath)
		return err
	}
	defer os.Remove(newPath)
	defer os.Remove(prevPath)

	u.log.Info("starting self-update", "url", url)

	if err := u.download(url, newPath); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	if err := verifySHA256(newPath, expectedSHA256); err != nil {
		return fmt.Errorf("checksum verification failed: %w", err)
	}
	if err := os.Chmod(newPath, 0o755); err != nil {
		return fmt.Errorf("chmod new binary: %w", err)
	}
	if err := copyFile(u.binaryPath, prevPath, 0o755); err != nil {
		return fmt.Errorf("backup current binary: %w", err)
	}
	if err := u.installFn(newPath, u.binaryPath); err != nil {
		return fmt.Errorf("promote new binary: %w", err)
	}

	u.log.Info("binary replaced, triggering service restart")
	if err := u.restartFn(); err != nil {
		u.log.Error("service restart failed, rolling back", "err", err)
		if rbErr := u.rollbackFn(prevPath, u.binaryPath); rbErr != nil {
			u.log.Error("rollback failed", "err", rbErr)
		}
		return fmt.Errorf("restart service: %w", err)
	}
	return nil
}

func (u *Updater) updateDirect(url, expectedSHA256 string) error {
	newPath := u.binaryPath + ".new"
	prevPath := u.binaryPath + ".prev"

	u.log.Info("starting self-update", "url", url)

	if err := u.download(url, newPath); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer os.Remove(newPath)

	if err := verifySHA256(newPath, expectedSHA256); err != nil {
		return fmt.Errorf("checksum verification failed: %w", err)
	}
	if err := os.Chmod(newPath, 0o755); err != nil {
		return fmt.Errorf("chmod new binary: %w", err)
	}
	if err := os.Rename(u.binaryPath, prevPath); err != nil {
		return fmt.Errorf("backup current binary: %w", err)
	}
	if err := os.Rename(newPath, u.binaryPath); err != nil {
		u.log.Error("rename failed, rolling back", "err", err)
		u.rollback(prevPath)
		return fmt.Errorf("promote new binary: %w", err)
	}

	u.log.Info("binary replaced, triggering service restart")
	if err := u.restartFn(); err != nil {
		u.log.Error("service restart failed, rolling back", "err", err)
		u.rollback(prevPath)
		return fmt.Errorf("restart service: %w", err)
	}
	return nil
}

// download fetches url and saves it to dest.
func (u *Updater) download(url, dest string) error {
	resp, err := u.httpClient.Get(url)
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

func (u *Updater) rollback(prevPath string) {
	if rbErr := os.Rename(prevPath, u.binaryPath); rbErr != nil {
		u.log.Error("rollback failed", "err", rbErr)
	}
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

func (u *Updater) tempArtifactPath(prefix string) (string, error) {
	f, err := os.CreateTemp("", prefix+filepath.Base(u.binaryPath)+"-*")
	if err != nil {
		return "", fmt.Errorf("create temp artifact: %w", err)
	}
	path := f.Name()
	if err := f.Close(); err != nil {
		os.Remove(path)
		return "", fmt.Errorf("close temp artifact: %w", err)
	}
	return path, nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}
