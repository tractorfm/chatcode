package config

import "testing"

func resetSelfHostCPURL(t *testing.T) {
	t.Helper()
	old := CPURLSelfHost
	t.Cleanup(func() {
		CPURLSelfHost = old
	})
}

func TestLoadReadsBootstrapTokenFromEnv(t *testing.T) {
	resetSelfHostCPURL(t)
	t.Setenv("GATEWAY_ID", "gw-test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", CPURLStaging)
	t.Setenv("GATEWAY_BOOTSTRAP_TOKEN", "boot-test")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.BootstrapToken != "boot-test" {
		t.Fatalf("BootstrapToken = %q, want %q", cfg.BootstrapToken, "boot-test")
	}
}

func TestLoadAllowsMissingBootstrapToken(t *testing.T) {
	resetSelfHostCPURL(t)
	t.Setenv("GATEWAY_ID", "gw-test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", CPURLStaging)
	t.Setenv("GATEWAY_BOOTSTRAP_TOKEN", "")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.BootstrapToken != "" {
		t.Fatalf("BootstrapToken = %q, want empty", cfg.BootstrapToken)
	}
}

func TestLoadRejectsInvalidGatewayID(t *testing.T) {
	resetSelfHostCPURL(t)
	t.Setenv("GATEWAY_ID", "gw test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", CPURLStaging)

	_, err := Load("")
	if err == nil {
		t.Fatal("Load() error = nil, want invalid gateway id error")
	}
}

func TestLoadAllowsSelfHostCPURLWhenBaked(t *testing.T) {
	resetSelfHostCPURL(t)
	CPURLSelfHost = "wss://cp.example.com/gw/connect"
	t.Setenv("GATEWAY_ID", "gw-test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", "wss://cp.example.com/gw/connect")

	if _, err := Load(""); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestLoadRejectsMalformedSelfHostCPURLBuildConfig(t *testing.T) {
	resetSelfHostCPURL(t)
	CPURLSelfHost = "http://cp.example.com/gw/connect"
	t.Setenv("GATEWAY_ID", "gw-test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", CPURLProd)

	if _, err := Load(""); err == nil {
		t.Fatal("Load() error = nil, want invalid self-host cp url error")
	}
}

func TestLoadDefaultsMaxSessionsToHardCap(t *testing.T) {
	resetSelfHostCPURL(t)
	t.Setenv("GATEWAY_ID", "gw-test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", CPURLStaging)
	t.Setenv("GATEWAY_MAX_SESSIONS", "")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.MaxSessions != DefaultMaxSessions {
		t.Fatalf("MaxSessions = %d, want %d", cfg.MaxSessions, DefaultMaxSessions)
	}
}

func TestLoadRejectsMaxSessionsAboveHardCap(t *testing.T) {
	resetSelfHostCPURL(t)
	t.Setenv("GATEWAY_ID", "gw-test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", CPURLStaging)
	t.Setenv("GATEWAY_MAX_SESSIONS", "51")

	_, err := Load("")
	if err == nil {
		t.Fatal("Load() error = nil, want max sessions validation error")
	}
}
