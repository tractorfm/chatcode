package agents

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
			if version, err := getVersion(binary); err == nil {
				status.Version = version
			}
		}
		out = append(out, status)
	}
	return out
}
