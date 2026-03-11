// Package config loads gateway configuration from environment variables and
// an optional config file (JSON). Environment variables take precedence.
package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Config holds all gateway configuration.
type Config struct {
	// GatewayID is the stable unique identifier for this gateway instance.
	// Assigned by the control plane at provisioning time.
	GatewayID string `json:"gateway_id"`

	// AuthToken is the bearer token used to authenticate with the control plane.
	AuthToken string `json:"auth_token"`

	// BootstrapToken is an optional one-time token used to register a new
	// manually installed gateway (BYO flow).
	BootstrapToken string `json:"bootstrap_token,omitempty"`

	// CPURL is the WebSocket URL of the control plane Gateway Durable Object.
	// e.g. "wss://cp.chatcode.dev/gw/connect"
	CPURL string `json:"cp_url"`

	// HealthInterval is how often to send gateway.health events. Default 30s.
	HealthInterval time.Duration `json:"health_interval"`

	// MaxSessions is the maximum number of concurrent sessions. Default 50.
	MaxSessions int `json:"max_sessions"`

	// TempDir is used for file upload staging. Default /tmp/vibecode.
	TempDir string `json:"temp_dir"`

	// BinaryPath is the path to the running gateway binary (for self-update).
	BinaryPath string `json:"binary_path"`

	// LogLevel: "debug", "info", "warn", "error". Default "info".
	LogLevel string `json:"log_level"`
}

const (
	CPURLProd          = "wss://cp.chatcode.dev/gw/connect"
	CPURLStaging       = "wss://cp.staging.chatcode.dev/gw/connect"
	DefaultMaxSessions = 50
	HardMaxSessions    = 50
)

var gatewayIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// CPURLSelfHost can be injected at build time for self-host releases:
//
//	-X github.com/tractorfm/chatcode/packages/gateway/internal/config.CPURLSelfHost=wss://cp.example.com/gw/connect
var CPURLSelfHost = ""

// Load returns a Config populated from the optional file at path, then
// overridden by environment variables.
//
// Required env vars: GATEWAY_ID, GATEWAY_AUTH_TOKEN, GATEWAY_CP_URL.
// Optional: GATEWAY_HEALTH_INTERVAL, GATEWAY_MAX_SESSIONS, GATEWAY_TEMP_DIR,
// GATEWAY_BINARY_PATH, GATEWAY_LOG_LEVEL,
// GATEWAY_BOOTSTRAP_TOKEN.
func Load(configFile string) (*Config, error) {
	cfg := defaults()

	if configFile != "" {
		if err := loadFile(cfg, configFile); err != nil {
			return nil, fmt.Errorf("config file %q: %w", configFile, err)
		}
	}

	applyEnv(cfg)

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func defaults() *Config {
	exe, _ := os.Executable()
	return &Config{
		HealthInterval: 30 * time.Second,
		MaxSessions:    DefaultMaxSessions,
		TempDir:        "/tmp/chatcode",
		BinaryPath:     exe,
		LogLevel:       "info",
	}
}

func loadFile(cfg *Config, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewDecoder(f).Decode(cfg)
}

func applyEnv(cfg *Config) {
	if v := os.Getenv("GATEWAY_ID"); v != "" {
		cfg.GatewayID = v
	}
	if v := os.Getenv("GATEWAY_AUTH_TOKEN"); v != "" {
		cfg.AuthToken = v
	}
	if v := os.Getenv("GATEWAY_BOOTSTRAP_TOKEN"); v != "" {
		cfg.BootstrapToken = v
	}
	if v := os.Getenv("GATEWAY_CP_URL"); v != "" {
		cfg.CPURL = v
	}
	if v := os.Getenv("GATEWAY_HEALTH_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.HealthInterval = d
		}
	}
	if v := os.Getenv("GATEWAY_MAX_SESSIONS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.MaxSessions = n
		}
	}
	if v := os.Getenv("GATEWAY_TEMP_DIR"); v != "" {
		cfg.TempDir = v
	}
	if v := os.Getenv("GATEWAY_BINARY_PATH"); v != "" {
		cfg.BinaryPath = v
	}
	if v := os.Getenv("GATEWAY_LOG_LEVEL"); v != "" {
		cfg.LogLevel = v
	}
}

func (c *Config) validate() error {
	if c.GatewayID == "" {
		return fmt.Errorf("GATEWAY_ID is required")
	}
	if !gatewayIDPattern.MatchString(c.GatewayID) {
		return fmt.Errorf("GATEWAY_ID must match %q", gatewayIDPattern.String())
	}
	if c.AuthToken == "" {
		return fmt.Errorf("GATEWAY_AUTH_TOKEN is required")
	}
	if c.CPURL == "" {
		return fmt.Errorf("GATEWAY_CP_URL is required")
	}
	if c.MaxSessions < 1 {
		return fmt.Errorf("GATEWAY_MAX_SESSIONS must be >= 1")
	}
	if c.MaxSessions > HardMaxSessions {
		return fmt.Errorf("GATEWAY_MAX_SESSIONS must be <= %d", HardMaxSessions)
	}
	allowed, err := allowedCPURLs()
	if err != nil {
		return err
	}
	for _, candidate := range allowed {
		if c.CPURL == candidate {
			return nil
		}
	}
	return fmt.Errorf("GATEWAY_CP_URL is not allowed for this build")
}

func allowedCPURLs() ([]string, error) {
	allowed := []string{CPURLProd, CPURLStaging}
	normalizedSelfHost, ok, err := NormalizedSelfHostCPURL()
	if err != nil {
		return nil, fmt.Errorf("invalid self-host control-plane URL in build config: %w", err)
	}
	if !ok {
		return allowed, nil
	}
	allowed = append(allowed, normalizedSelfHost)
	return allowed, nil
}

// NormalizedSelfHostCPURL returns the configured build-time self-host CP URL.
// ok=false means no self-host URL is configured for this build.
func NormalizedSelfHostCPURL() (normalized string, ok bool, err error) {
	if CPURLSelfHost == "" {
		return "", false, nil
	}
	normalized, err = normalizeCPURL(CPURLSelfHost)
	if err != nil {
		return "", false, err
	}
	return normalized, true, nil
}

func normalizeCPURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("parse URL: %w", err)
	}
	if u.Scheme != "wss" {
		return "", fmt.Errorf("scheme must be wss")
	}
	if u.User != nil {
		return "", fmt.Errorf("userinfo is not allowed")
	}
	if u.Host == "" {
		return "", fmt.Errorf("missing host")
	}
	if u.Path != "/gw/connect" {
		return "", fmt.Errorf("path must be /gw/connect")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("query and fragment are not allowed")
	}
	return u.String(), nil
}
