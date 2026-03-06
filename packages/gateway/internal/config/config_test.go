package config

import "testing"

func TestLoadReadsBootstrapTokenFromEnv(t *testing.T) {
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
	t.Setenv("GATEWAY_ID", "gw test")
	t.Setenv("GATEWAY_AUTH_TOKEN", "auth-test")
	t.Setenv("GATEWAY_CP_URL", CPURLStaging)

	_, err := Load("")
	if err == nil {
		t.Fatal("Load() error = nil, want invalid gateway id error")
	}
}
