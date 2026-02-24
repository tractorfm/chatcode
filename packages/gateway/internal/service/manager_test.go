package service

import (
	"context"
	"errors"
	"runtime"
	"testing"
)

func TestDetectBackend(t *testing.T) {
	got := DetectBackend()
	switch runtime.GOOS {
	case "linux":
		if got != BackendSystemd {
			t.Fatalf("DetectBackend() = %q, want %q", got, BackendSystemd)
		}
	case "darwin":
		if got != BackendLaunchd {
			t.Fatalf("DetectBackend() = %q, want %q", got, BackendLaunchd)
		}
	default:
		if got != BackendUnknown {
			t.Fatalf("DetectBackend() = %q, want %q", got, BackendUnknown)
		}
	}
}

func TestScaffoldManagerReturnsNotImplemented(t *testing.T) {
	m := NewManager()
	if m == nil {
		t.Fatal("NewManager() returned nil")
	}

	err := m.Install(context.Background(), UnitConfig{Name: "vibecode-gateway"})
	if !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("Install() error = %v, want ErrNotImplemented", err)
	}

	err = m.Uninstall(context.Background(), UninstallOptions{})
	if !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("Uninstall() error = %v, want ErrNotImplemented", err)
	}
}
