package config

import "testing"

func TestLoadReadsBootstrapTokenFromEnv(t *testing.T) {
	t.Setenv("GATEWAY_ID", "gw-test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", "wss://cp.example.test/gw/connect")
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
	t.Setenv("GATEWAY_ID", "gw-test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", "wss://cp.example.test/gw/connect")
	t.Setenv("GATEWAY_BOOTSTRAP_TOKEN", "")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.BootstrapToken != "" {
		t.Fatalf("BootstrapToken = %q, want empty", cfg.BootstrapToken)
	}
}
