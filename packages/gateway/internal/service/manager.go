// Package service defines service-manager abstractions for gateway lifecycle.
package service

import (
	"context"
	"errors"
	"fmt"
	"runtime"
)

// Backend identifies a host service manager implementation.
type Backend string

const (
	BackendSystemd Backend = "systemd"
	BackendLaunchd Backend = "launchd"
	BackendUnknown Backend = "unknown"
)

// ErrNotImplemented marks service operations that are scaffolded but not yet
// implemented by a concrete backend.
var ErrNotImplemented = errors.New("service manager backend not implemented")

// UnitConfig describes a gateway service definition.
type UnitConfig struct {
	Name             string
	Description      string
	ExecStart        string
	User             string
	WorkingDirectory string
	EnvironmentFile  string
}

// UninstallOptions controls how service uninstall behaves.
type UninstallOptions struct {
	RemoveBinary bool
	BinaryPath   string
}

// Manager abstracts service install/uninstall flows for systemd/launchd.
type Manager interface {
	Backend() Backend
	Install(context.Context, UnitConfig) error
	Uninstall(context.Context, UninstallOptions) error
}

// DetectBackend determines the service backend from OS.
func DetectBackend() Backend {
	switch runtime.GOOS {
	case "linux":
		return BackendSystemd
	case "darwin":
		return BackendLaunchd
	default:
		return BackendUnknown
	}
}

// NewManager returns a scaffold manager for the detected backend.
func NewManager() Manager {
	return &scaffoldManager{backend: DetectBackend()}
}

type scaffoldManager struct {
	backend Backend
}

func (m *scaffoldManager) Backend() Backend {
	return m.backend
}

func (m *scaffoldManager) Install(_ context.Context, _ UnitConfig) error {
	return fmt.Errorf("%w: %s", ErrNotImplemented, m.backend)
}

func (m *scaffoldManager) Uninstall(_ context.Context, _ UninstallOptions) error {
	return fmt.Errorf("%w: %s", ErrNotImplemented, m.backend)
}
