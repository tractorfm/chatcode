// Package protocol defines the gateway ↔ control plane protocol types.
//
// Hand-written to match packages/protocol/schema/commands.json and events.json.
// Binary frame encoding/decoding is also implemented here.
package protocol

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"time"
)

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

// CommandType identifies the type of a command from CP → gateway.
type CommandType string

// EventType identifies the type of an event from gateway → CP.
type EventType string

const (
	// Commands (CP → gateway)
	CmdSessionCreate   CommandType = "session.create"
	CmdSessionInput    CommandType = "session.input"
	CmdSessionResize   CommandType = "session.resize"
	CmdSessionEnd      CommandType = "session.end"
	CmdSessionAck      CommandType = "session.ack"
	CmdSessionSnapshot CommandType = "session.snapshot"
	CmdSSHAuthorize    CommandType = "ssh.authorize"
	CmdSSHRevoke       CommandType = "ssh.revoke"
	CmdSSHList         CommandType = "ssh.list"
	CmdFileUploadBegin CommandType = "file.upload.begin"
	CmdFileUploadChunk CommandType = "file.upload.chunk"
	CmdFileUploadEnd   CommandType = "file.upload.end"
	CmdFileDownload    CommandType = "file.download"
	CmdFileCancel      CommandType = "file.cancel"
	CmdAgentsInstall   CommandType = "agents.install"
	CmdGatewayUpdate   CommandType = "gateway.update"

	// Events (gateway → CP)
	EvtAck              EventType = "ack"
	EvtGatewayHello     EventType = "gateway.hello"
	EvtGatewayHealth    EventType = "gateway.health"
	EvtSessionStarted   EventType = "session.started"
	EvtSessionEnded     EventType = "session.ended"
	EvtSessionError     EventType = "session.error"
	EvtSessionSnapshot  EventType = "session.snapshot"
	EvtSSHKeys          EventType = "ssh.keys"
	EvtFileContentBegin EventType = "file.content.begin"
	EvtFileContentChunk EventType = "file.content.chunk"
	EvtFileContentEnd   EventType = "file.content.end"
	EvtAgentInstalled   EventType = "agent.installed"
	EvtGatewayUpdated   EventType = "gateway.updated"
)

// ---------------------------------------------------------------------------
// Commands: control plane → gateway
// ---------------------------------------------------------------------------

// RawCommand is used to peek at the type before full unmarshalling.
type RawCommand struct {
	Type          CommandType     `json:"type"`
	SchemaVersion string          `json:"schema_version,omitempty"`
	RequestID     string          `json:"request_id"`
	Raw           json.RawMessage `json:"-"`
}

// Ack is sent by the gateway in response to any command.
type Ack struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	RequestID     string    `json:"request_id"`
	OK            bool      `json:"ok"`
	Error         string    `json:"error,omitempty"`
}

// AgentType identifies the AI agent to use.
type AgentType string

const (
	AgentClaudeCode AgentType = "claude-code"
	AgentCodex      AgentType = "codex"
	AgentGemini     AgentType = "gemini"
	AgentNone       AgentType = "none"
)

// AgentConfig allows the CP to override default agent instructions.
type AgentConfig struct {
	ClaudeMD string `json:"claude_md,omitempty"`
	AgentsMD string `json:"agents_md,omitempty"`
}

// SessionCreate starts a new tmux/PTY session.
type SessionCreate struct {
	Type          CommandType       `json:"type"`
	SchemaVersion string            `json:"schema_version,omitempty"`
	RequestID     string            `json:"request_id"`
	SessionID     string            `json:"session_id"`
	Name          string            `json:"name"`
	Workdir       string            `json:"workdir"`
	Agent         AgentType         `json:"agent,omitempty"`
	AgentConfig   *AgentConfig      `json:"agent_config,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
}

// SessionInput injects keystrokes into a tmux pane.
type SessionInput struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	SessionID     string      `json:"session_id"`
	// Data is base64-encoded input bytes.
	Data string `json:"data"`
}

// SessionResize resizes a tmux window.
type SessionResize struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	SessionID     string      `json:"session_id"`
	Cols          int         `json:"cols"`
	Rows          int         `json:"rows"`
}

// SessionEnd terminates a session.
type SessionEnd struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	SessionID     string      `json:"session_id"`
}

// SessionAck is forwarded client ack state for binary stream sequencing.
type SessionAck struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	SessionID     string      `json:"session_id"`
	Seq           uint64      `json:"seq"`
}

// SessionSnapshotCmd requests a terminal snapshot.
type SessionSnapshotCmd struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	SessionID     string      `json:"session_id"`
}

// SSHAuthorize adds a public key to authorized_keys.
type SSHAuthorize struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	PublicKey     string      `json:"public_key"`
	Label         string      `json:"label"`
	ExpiresAt     *time.Time  `json:"expires_at,omitempty"`
}

// SSHRevoke removes a key by fingerprint.
type SSHRevoke struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	Fingerprint   string      `json:"fingerprint"`
}

// SSHListCmd requests the list of authorized keys.
type SSHListCmd struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
}

// FileUploadBegin initiates a file upload.
type FileUploadBegin struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	TransferID    string      `json:"transfer_id"`
	DestPath      string      `json:"dest_path"`
	Size          int64       `json:"size"`
	TotalChunks   int         `json:"total_chunks"`
}

// FileUploadChunk sends a chunk of an in-progress upload.
type FileUploadChunk struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	TransferID    string      `json:"transfer_id"`
	Seq           int         `json:"seq"`
	// Data is base64-encoded chunk bytes.
	Data string `json:"data"`
}

// FileUploadEnd finalises an upload and moves the temp file to dest_path.
type FileUploadEnd struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	TransferID    string      `json:"transfer_id"`
}

// FileDownload requests a file to be sent back in chunks.
type FileDownload struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	TransferID    string      `json:"transfer_id"`
	Path          string      `json:"path"`
}

// FileCancel cancels an in-progress transfer.
type FileCancel struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	TransferID    string      `json:"transfer_id"`
}

// AgentsInstall installs an AI agent on the VPS.
type AgentsInstall struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	Agent         AgentType   `json:"agent"`
}

// GatewayUpdateCmd triggers a self-update.
type GatewayUpdateCmd struct {
	Type          CommandType `json:"type"`
	SchemaVersion string      `json:"schema_version,omitempty"`
	RequestID     string      `json:"request_id"`
	URL           string      `json:"url"`
	SHA256        string      `json:"sha256"`
	Version       string      `json:"version"`
}

// ---------------------------------------------------------------------------
// Events: gateway → control plane
// ---------------------------------------------------------------------------

// GatewayHello is sent immediately after WebSocket connect.
type GatewayHello struct {
	Type           EventType  `json:"type"`
	SchemaVersion  string     `json:"schema_version,omitempty"`
	GatewayID      string     `json:"gateway_id"`
	Version        string     `json:"version"`
	Hostname       string     `json:"hostname"`
	GoVersion      string     `json:"go_version,omitempty"`
	BootstrapToken string     `json:"bootstrap_token,omitempty"`
	SystemInfo     SystemInfo `json:"system_info"`
}

// SystemInfo contains basic machine metadata useful during registration.
type SystemInfo struct {
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	CPUs           int    `json:"cpus"`
	RAMTotalBytes  uint64 `json:"ram_total_bytes"`
	DiskTotalBytes uint64 `json:"disk_total_bytes"`
}

// ActiveSession summarises an active session for health reports.
type ActiveSession struct {
	SessionID      string    `json:"session_id"`
	LastActivityAt time.Time `json:"last_activity_at"`
}

// GatewayHealth is sent on a 30s interval.
type GatewayHealth struct {
	Type           EventType       `json:"type"`
	SchemaVersion  string          `json:"schema_version,omitempty"`
	GatewayID      string          `json:"gateway_id"`
	Timestamp      time.Time       `json:"timestamp"`
	CPUPercent     float64         `json:"cpu_percent,omitempty"`
	RAMUsedBytes   uint64          `json:"ram_used_bytes,omitempty"`
	RAMTotalBytes  uint64          `json:"ram_total_bytes,omitempty"`
	DiskUsedBytes  uint64          `json:"disk_used_bytes,omitempty"`
	DiskTotalBytes uint64          `json:"disk_total_bytes,omitempty"`
	UptimeSeconds  int64           `json:"uptime_seconds,omitempty"`
	ActiveSessions []ActiveSession `json:"active_sessions"`
}

// SessionStarted confirms a session was created.
type SessionStarted struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	RequestID     string    `json:"request_id"`
	SessionID     string    `json:"session_id"`
	PID           int       `json:"pid,omitempty"`
}

// SessionEnded reports that a session has terminated.
type SessionEnded struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	SessionID     string    `json:"session_id"`
	ExitCode      int       `json:"exit_code,omitempty"`
}

// SessionErrorEvent reports a session-level error.
type SessionErrorEvent struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	SessionID     string    `json:"session_id"`
	Error         string    `json:"error"`
}

// SessionSnapshotEvent carries terminal content.
type SessionSnapshotEvent struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	RequestID     string    `json:"request_id,omitempty"`
	SessionID     string    `json:"session_id"`
	Content       string    `json:"content"`
	Cols          int       `json:"cols,omitempty"`
	Rows          int       `json:"rows,omitempty"`
}

// SSHKey describes an entry in authorized_keys.
type SSHKey struct {
	Fingerprint string     `json:"fingerprint"`
	Label       string     `json:"label"`
	Algorithm   string     `json:"algorithm"`
	AddedAt     *time.Time `json:"added_at,omitempty"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
}

// SSHKeyList is the response to ssh.list.
type SSHKeyList struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	RequestID     string    `json:"request_id"`
	Keys          []SSHKey  `json:"keys"`
}

// FileContentBegin starts a file download from gateway to CP.
type FileContentBegin struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	TransferID    string    `json:"transfer_id"`
	Path          string    `json:"path"`
	Size          int64     `json:"size"`
	TotalChunks   int       `json:"total_chunks"`
}

// FileContentChunk carries a chunk of a file download.
type FileContentChunk struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	TransferID    string    `json:"transfer_id"`
	Seq           int       `json:"seq"`
	// Data is base64-encoded chunk bytes.
	Data string `json:"data"`
}

// FileContentEnd signals the end of a file download.
type FileContentEnd struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	TransferID    string    `json:"transfer_id"`
}

// AgentInstalled confirms an agent was installed.
type AgentInstalled struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	RequestID     string    `json:"request_id"`
	Agent         string    `json:"agent"`
	Version       string    `json:"version,omitempty"`
}

// GatewayUpdated confirms a self-update completed.
type GatewayUpdated struct {
	Type          EventType `json:"type"`
	SchemaVersion string    `json:"schema_version,omitempty"`
	RequestID     string    `json:"request_id"`
	Version       string    `json:"version"`
}

// ---------------------------------------------------------------------------
// Binary frame encoding (terminal output)
// ---------------------------------------------------------------------------

// FrameKindTerminalOutput is the kind byte for PTY output frames.
const FrameKindTerminalOutput byte = 0x01

// EncodeTerminalFrame builds a binary frame for PTY output.
//
// Layout: [kind:1][session_id_len:1][session_id:N][seq:8][payload:M]
func EncodeTerminalFrame(sessionID string, seq uint64, payload []byte) ([]byte, error) {
	idBytes := []byte(sessionID)
	if len(idBytes) > 255 {
		return nil, fmt.Errorf("session_id too long: %d bytes", len(idBytes))
	}
	buf := make([]byte, 1+1+len(idBytes)+8+len(payload))
	offset := 0
	buf[offset] = FrameKindTerminalOutput
	offset++
	buf[offset] = byte(len(idBytes))
	offset++
	copy(buf[offset:], idBytes)
	offset += len(idBytes)
	binary.BigEndian.PutUint64(buf[offset:], seq)
	offset += 8
	copy(buf[offset:], payload)
	return buf, nil
}

// DecodeTerminalFrame parses a binary terminal output frame.
func DecodeTerminalFrame(buf []byte) (sessionID string, seq uint64, payload []byte, err error) {
	if len(buf) < 2 {
		return "", 0, nil, fmt.Errorf("frame too short")
	}
	if buf[0] != FrameKindTerminalOutput {
		return "", 0, nil, fmt.Errorf("unexpected frame kind: %d", buf[0])
	}
	idLen := int(buf[1])
	if len(buf) < 2+idLen+8 {
		return "", 0, nil, fmt.Errorf("frame truncated")
	}
	sessionID = string(buf[2 : 2+idLen])
	seq = binary.BigEndian.Uint64(buf[2+idLen : 2+idLen+8])
	payload = buf[2+idLen+8:]
	return sessionID, seq, payload, nil
}
