package ssh

import (
	"context"
	"log/slog"
	"time"
)

// StartExpiryWatcher runs a background goroutine that periodically removes
// expired SSH keys. It stops when ctx is cancelled.
func StartExpiryWatcher(ctx context.Context, m *Manager, interval time.Duration, log *slog.Logger) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := m.RemoveExpired(); err != nil {
					log.Warn("ssh expiry cleanup failed", "err", err)
				}
			}
		}
	}()
}
