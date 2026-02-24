package main

import (
	"testing"

	"github.com/tractorfm/chatcode/packages/gateway/internal/config"
	"github.com/tractorfm/chatcode/packages/gateway/internal/health"
)

func TestBuildHelloEventIncludesBYOFields(t *testing.T) {
	cfg := &config.Config{
		GatewayID:      "gw-123",
		BootstrapToken: "boot-123",
	}
	info := health.SystemInfo{
		OS:             "linux",
		Arch:           "amd64",
		CPUs:           8,
		RAMTotalBytes:  16 * 1024 * 1024 * 1024,
		DiskTotalBytes: 500 * 1024 * 1024 * 1024,
	}
	hello := buildHelloEvent(cfg, "host-1", info)

	if hello["type"] != "gateway.hello" {
		t.Fatalf("type = %v, want gateway.hello", hello["type"])
	}
	if hello["gateway_id"] != "gw-123" {
		t.Fatalf("gateway_id = %v, want gw-123", hello["gateway_id"])
	}
	if hello["bootstrap_token"] != "boot-123" {
		t.Fatalf("bootstrap_token = %v, want boot-123", hello["bootstrap_token"])
	}

	si, ok := hello["system_info"].(map[string]any)
	if !ok {
		t.Fatalf("system_info missing or wrong type: %T", hello["system_info"])
	}
	if si["os"] != "linux" {
		t.Fatalf("system_info.os = %v, want linux", si["os"])
	}
	if si["arch"] != "amd64" {
		t.Fatalf("system_info.arch = %v, want amd64", si["arch"])
	}
	if si["cpus"] != 8 {
		t.Fatalf("system_info.cpus = %v, want 8", si["cpus"])
	}
}

func TestBuildHelloEventOmitsBootstrapTokenWhenEmpty(t *testing.T) {
	cfg := &config.Config{GatewayID: "gw-123"}
	hello := buildHelloEvent(cfg, "host-1", health.SystemInfo{})
	if _, ok := hello["bootstrap_token"]; ok {
		t.Fatalf("bootstrap_token should be omitted when empty")
	}
}
