// Package agents manages AI agent installation on the VPS.
package agents

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"

	gw "github.com/tractorfm/chatcode/packages/gateway"
)

// AgentName identifies a supported AI agent.
type AgentName string

const (
	AgentClaudeCode AgentName = "claude-code"
	AgentCodex      AgentName = "codex"
	AgentGemini     AgentName = "gemini"
)

// Install runs the embedded install script for the given agent and returns
// the installed version string.
func Install(agent AgentName) (version string, err error) {
	script, binaryName, err := agentScript(agent)
	if err != nil {
		return "", err
	}

	// Write script to a temp file and execute it
	tmp, err := os.CreateTemp("", "vibecode-install-*.sh")
	if err != nil {
		return "", fmt.Errorf("create temp script: %w", err)
	}
	defer os.Remove(tmp.Name())

	if _, err := tmp.WriteString(script); err != nil {
		tmp.Close()
		return "", fmt.Errorf("write script: %w", err)
	}
	tmp.Close()

	if err := os.Chmod(tmp.Name(), 0o700); err != nil {
		return "", fmt.Errorf("chmod script: %w", err)
	}

	cmd := exec.Command("/bin/bash", tmp.Name())
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("install script for %q failed: %w", agent, err)
	}

	// Verify agent is in PATH
	if err := verifyInPath(binaryName); err != nil {
		return "", fmt.Errorf("agent %q not found in PATH after install: %w", agent, err)
	}

	// Get version
	version, _ = getVersion(binaryName)
	return version, nil
}

func agentScript(agent AgentName) (script, binaryName string, err error) {
	switch agent {
	case AgentClaudeCode:
		return gw.InstallClaudeCodeScript, "claude", nil
	case AgentCodex:
		return gw.InstallCodexScript, "codex", nil
	case AgentGemini:
		return gw.InstallGeminiScript, "gemini", nil
	default:
		return "", "", fmt.Errorf("unknown agent: %q", agent)
	}
}

func verifyInPath(binary string) error {
	_, err := exec.LookPath(binary)
	return err
}

func getVersion(binary string) (string, error) {
	var args []string
	switch binary {
	case "claude":
		args = []string{"--version"}
	case "codex":
		args = []string{"--version"}
	case "gemini":
		args = []string{"--version"}
	default:
		args = []string{"--version"}
	}

	out, err := exec.Command(binary, args...).Output()
	if err != nil {
		return "", err
	}
	// Return first line of version output
	lines := strings.SplitN(strings.TrimSpace(string(bytes.TrimSpace(out))), "\n", 2)
	if len(lines) > 0 {
		return lines[0], nil
	}
	return "", nil
}
