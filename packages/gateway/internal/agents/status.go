package agents

import "time"

const statusVersionTimeout = 1500 * time.Millisecond

// Status reports whether a supported agent is currently available on PATH.
type Status struct {
	Agent     AgentName `json:"agent"`
	Binary    string    `json:"binary"`
	Installed bool      `json:"installed"`
	Version   string    `json:"version,omitempty"`
}

// ListStatus returns current status for all supported agent CLIs.
func ListStatus() []Status {
	out := make([]Status, 0, len(supportedAgents()))
	for _, agent := range supportedAgents() {
		binary, err := binaryForAgent(agent)
		if err != nil {
			continue
		}
		status := Status{Agent: agent, Binary: binary}
		if err := verifyInPath(binary); err == nil {
			status.Installed = true
			// Keep status checks responsive even when some CLIs are slow to boot.
			if shouldProbeVersion(agent) {
				if version, err := getVersionWithTimeout(binary, statusVersionTimeout); err == nil {
					status.Version = version
				}
			}
		}
		out = append(out, status)
	}
	return out
}

// IsInstalled reports whether the selected supported agent binary is available on PATH.
func IsInstalled(agent AgentName) (bool, error) {
	binary, err := binaryForAgent(agent)
	if err != nil {
		return false, err
	}
	return verifyInPath(binary) == nil, nil
}

func shouldProbeVersion(agent AgentName) bool {
	// Intentionally allow-list only fast version probes so agents.list stays
	// responsive on low-memory VPSes. New agents default to "installed" without
	// a version string until explicitly opted in here.
	switch agent {
	case AgentClaudeCode, AgentCodex:
		return true
	default:
		return false
	}
}
