// Command gateway is the Chatcode.dev gateway daemon.
// It runs on a user's VPS, connects to the control plane via WebSocket,
// and manages tmux/PTY sessions, SSH keys, and file transfers.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/tractorfm/chatcode/packages/gateway/internal/agents"
	"github.com/tractorfm/chatcode/packages/gateway/internal/config"
	"github.com/tractorfm/chatcode/packages/gateway/internal/files"
	"github.com/tractorfm/chatcode/packages/gateway/internal/health"
	"github.com/tractorfm/chatcode/packages/gateway/internal/session"
	sshkeys "github.com/tractorfm/chatcode/packages/gateway/internal/ssh"
	"github.com/tractorfm/chatcode/packages/gateway/internal/update"
	"github.com/tractorfm/chatcode/packages/gateway/internal/workspace"
	"github.com/tractorfm/chatcode/packages/gateway/internal/ws"
)

// Version and BuildTime are set via ldflags at build time.
var (
	Version   = "dev"
	BuildTime = "unknown"
)

const schemaVersion = "1"

const maxCommandFrameBytes = 1 << 20 // 1 MiB
const maxSnapshotBytes = 900 * 1024  // bounded below 1 MiB payload ceiling

var requestIDRegexp = regexp.MustCompile(`"request_id"\s*:\s*"([^"]+)"`)

func main() {
	configFile := flag.String("config", "", "Path to JSON config file (optional; env vars take precedence)")
	flag.Parse()

	cfg, err := config.Load(*configFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		os.Exit(1)
	}

	log := newLogger(cfg.LogLevel)
	log.Info("vibecode gateway starting", "version", Version, "build_time", BuildTime)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	g := &gateway{
		cfg:      cfg,
		log:      log,
		sessions: session.NewManager(cfg.MaxSessions),
		health:   health.NewCollector("/"),
		updater:  update.NewUpdater(cfg.BinaryPath, log),
	}
	g.sessions.SetOnSessionExit(func(sessionID string) {
		g.onSessionExit(sessionID)
	})
	g.sshMgr, err = sshkeys.NewManager()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ssh manager init error: %v\n", err)
		os.Exit(1)
	}

	// Output channel: session output chunks → WS sender goroutine
	g.outputCh = make(chan session.OutputChunk, 256)

	// Recover existing tmux sessions after daemon restart so contexts survive.
	// These are session IDs previously created by control-plane (vibe-ses-*).
	recovered, err := g.sessions.Recover(g.outputCh)
	if err != nil {
		g.log.Warn("session recovery failed", "err", err)
	} else if len(recovered) > 0 {
		g.log.Info("recovered sessions", "count", len(recovered))
	}

	// Start SSH expiry watcher
	sshkeys.StartExpiryWatcher(ctx, g.sshMgr, 5*time.Minute, log)

	// Create file handler (sender will be wired after WS client is set up)
	// We use a late-binding sender so the WS client can be nil during startup
	workspaceRoot, err := resolveWorkspaceRoot()
	if err != nil {
		workspaceRoot = "/home/vibe/workspace"
	}
	g.workspaceRoot = workspaceRoot
	g.files = files.NewHandler(cfg.TempDir, workspaceRoot, func(ctx context.Context, v any) error {
		return g.wsClient.SendJSON(ctx, v)
	})

	// Create WS client.
	// Target selection is enum-based (prod/staging/selfhost), so dial URLs are
	// build-time controlled and not runtime-composed from arbitrary input.
	target := ws.TargetProd
	switch cfg.CPURL {
	case config.CPURLStaging:
		target = ws.TargetStaging
	case config.CPURLProd:
		target = ws.TargetProd
	default:
		target = ws.TargetSelfHost
	}
	g.wsClient = ws.NewClient(
		cfg.GatewayID,
		cfg.AuthToken,
		target,
		g.onTextFrame,
		nil, // gateway doesn't receive binary frames
		log,
	)

	// Start output forwarder (sends PTY output chunks over WS)
	go g.forwardOutput(ctx)

	// Start health ticker
	go g.runHealthTicker(ctx)
	go g.runFileTransferPruner(ctx)

	// Run WS client (blocks, reconnects on disconnect, calls onConnect each time)
	// We wrap the standard client to hook into connect events for hello + snapshots
	g.runWSWithHello(ctx)

	log.Info("gateway stopped")
}

// gateway holds all subsystem state.
type gateway struct {
	cfg      *config.Config
	log      *slog.Logger
	wsClient *ws.Client
	sessions *session.Manager
	sshMgr   *sshkeys.Manager
	health   *health.Collector
	updater  *update.Updater
	files    *files.Handler
	outputCh chan session.OutputChunk
	workspaceRoot string
}

func resolveWorkspaceRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", err
	}
	cleanHome := filepath.Clean(home)
	if filepath.Base(cleanHome) == "workspace" {
		return cleanHome, nil
	}
	return filepath.Join(cleanHome, "workspace"), nil
}

func (g *gateway) onSessionExit(sessionID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	g.log.Info("session exited", "session_id", sessionID)
	g.sendEvent(ctx, map[string]any{
		"type":           "session.ended",
		"schema_version": schemaVersion,
		"session_id":     sessionID,
	})
}

// runWSWithHello wraps ws.Client.Run to send gateway.hello on each (re)connect.
// Since nhooyr.io/websocket doesn't expose an onConnect hook, we run the client
// in a loop and detect reconnects by watching the Connected() state change.
func (g *gateway) runWSWithHello(ctx context.Context) {
	// The WS client calls onText handlers already. We need to send hello on each
	// connection. We achieve this by watching for the first text or binary frame
	// after a connect gap – but a simpler approach: subclass by running our own loop.
	//
	// Since ws.Client.Run already handles reconnect, we start a side goroutine that
	// polls Connected() and sends hello when it transitions false→true.
	go func() {
		wasConnected := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(100 * time.Millisecond):
				now := g.wsClient.Connected()
				if now && !wasConnected {
					g.sendHello(ctx)
					g.sendHealth(ctx)
					g.sendSnapshots(ctx)
				}
				wasConnected = now
			}
		}
	}()

	g.wsClient.Run(ctx)
}

func (g *gateway) sendHello(ctx context.Context) {
	hostname, _ := os.Hostname()
	info := g.health.SystemInfo()
	hello := buildHelloEvent(g.cfg, hostname, info)
	if err := g.wsClient.SendJSON(ctx, hello); err != nil {
		g.log.Warn("send hello failed", "err", err)
	} else {
		g.log.Info("sent gateway.hello")
	}
}

func buildHelloEvent(cfg *config.Config, hostname string, info health.SystemInfo) map[string]any {
	hello := map[string]any{
		"type":           "gateway.hello",
		"schema_version": schemaVersion,
		"gateway_id":     cfg.GatewayID,
		"version":        Version,
		"hostname":       hostname,
		"go_version":     runtime.Version(),
		"system_info": map[string]any{
			"os":               info.OS,
			"arch":             info.Arch,
			"cpus":             info.CPUs,
			"ram_total_bytes":  info.RAMTotalBytes,
			"disk_total_bytes": info.DiskTotalBytes,
		},
	}
	if cfg.BootstrapToken != "" {
		hello["bootstrap_token"] = cfg.BootstrapToken
	}
	return hello
}

func (g *gateway) sendSnapshots(ctx context.Context) {
	for _, s := range g.sessions.List() {
		sess := g.sessions.Get(s.SessionID)
		if sess == nil {
			continue
		}
		content, cols, rows, cursorX, cursorY, cursorVisible, err := sess.Snapshot()
		if err != nil {
			continue
		}
		content = trimSnapshotTail(content, maxSnapshotBytes)
		evt := map[string]any{
			"type":       "session.snapshot",
			"session_id": s.SessionID,
			"content":    content,
			"cols":       cols,
			"rows":       rows,
		}
		if cursorX >= 0 {
			evt["cursor_x"] = cursorX
		}
		if cursorY >= 0 {
			evt["cursor_y"] = cursorY
		}
		if cursorVisible == 0 {
			evt["cursor_visible"] = false
		} else if cursorVisible == 1 {
			evt["cursor_visible"] = true
		}
		g.sendEvent(ctx, evt)
	}
}

// onTextFrame dispatches incoming JSON commands from the control plane.
func (g *gateway) onTextFrame(ctx context.Context, raw json.RawMessage) {
	if len(raw) > maxCommandFrameBytes {
		g.log.Warn("command payload too large", "bytes", len(raw), "max_bytes", maxCommandFrameBytes)
		if requestID := extractRequestID(raw); requestID != "" {
			g.sendAck(ctx, requestID, false, fmt.Sprintf("payload exceeds max size (%d bytes)", maxCommandFrameBytes))
		}
		return
	}

	var base struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		g.log.Warn("unparseable text frame", "err", err)
		if requestID := extractRequestID(raw); requestID != "" {
			g.sendAck(ctx, requestID, false, "invalid command payload")
		}
		return
	}

	var err error
	switch base.Type {
	case "session.create":
		err = g.handleSessionCreate(ctx, raw)
	case "session.input":
		err = g.handleSessionInput(ctx, raw)
	case "session.resize":
		err = g.handleSessionResize(ctx, raw)
	case "session.end":
		err = g.handleSessionEnd(ctx, raw)
	case "session.ack":
		err = g.handleSessionAck(ctx, raw)
	case "session.snapshot":
		err = g.handleSessionSnapshot(ctx, raw)
	case "ssh.authorize":
		err = g.handleSSHAuthorize(ctx, raw)
	case "ssh.revoke":
		err = g.handleSSHRevoke(ctx, raw)
	case "ssh.list":
		err = g.handleSSHList(ctx, raw)
	case "file.upload.begin":
		err = g.handleFileUploadBegin(ctx, raw)
	case "file.upload.chunk":
		err = g.handleFileUploadChunk(ctx, raw)
	case "file.upload.end":
		err = g.handleFileUploadEnd(ctx, raw)
	case "file.download":
		err = g.handleFileDownload(ctx, raw)
	case "file.cancel":
		err = g.handleFileCancel(ctx, raw)
	case "agents.install":
		err = g.handleAgentsInstall(ctx, raw)
	case "agents.list":
		err = g.handleAgentsList(ctx, raw)
	case "workspace.list":
		err = g.handleWorkspaceList(ctx, raw)
	case "gateway.update":
		err = g.handleGatewayUpdate(ctx, raw)
	default:
		g.log.Warn("unknown command type", "type", base.Type)
		g.sendAck(ctx, base.RequestID, false, "unknown command: "+base.Type)
		return
	}

	if err != nil {
		g.log.Error("command failed", "type", base.Type, "err", err)
		g.sendAck(ctx, base.RequestID, false, err.Error())
	}
}

func (g *gateway) sendAck(ctx context.Context, requestID string, ok bool, errMsg string) {
	ack := map[string]any{
		"type":           "ack",
		"schema_version": schemaVersion,
		"request_id":     requestID,
		"ok":             ok,
	}
	if errMsg != "" {
		ack["error"] = errMsg
	}
	g.wsClient.SendJSON(ctx, ack)
}

// ----- Session handlers -----

func (g *gateway) handleSessionCreate(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID   string `json:"request_id"`
		SessionID   string `json:"session_id"`
		Name        string `json:"name"`
		Workdir     string `json:"workdir"`
		Agent       string `json:"agent"`
		AgentConfig *struct {
			ClaudeMD string `json:"claude_md"`
			AgentsMD string `json:"agents_md"`
		} `json:"agent_config"`
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}

	opts := session.Options{
		SessionID: cmd.SessionID,
		Name:      cmd.Name,
		Workdir:   cmd.Workdir,
		Agent:     cmd.Agent,
		Env:       cmd.Env,
		OutputCh:  g.outputCh,
	}
	if cmd.AgentConfig != nil {
		opts.ClaudeMD = cmd.AgentConfig.ClaudeMD
		opts.AgentsMD = cmd.AgentConfig.AgentsMD
	}

	if cmd.Agent != "" && cmd.Agent != "none" {
		installed, err := agents.IsInstalled(agents.AgentName(cmd.Agent))
		if err != nil {
			return err
		}
		if !installed {
			return fmt.Errorf("%s is not installed. Run agents.install first.", cmd.Agent)
		}
	}

	s, err := g.sessions.Create(opts)
	if err != nil {
		return err
	}
	_ = s

	g.sendEvent(ctx, map[string]any{
		"type":       "session.started",
		"request_id": cmd.RequestID,
		"session_id": cmd.SessionID,
	})
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleSessionInput(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
		SessionID string `json:"session_id"`
		Data      string `json:"data"` // base64
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	s := g.sessions.Get(cmd.SessionID)
	if s == nil {
		return fmt.Errorf("session %q not found", cmd.SessionID)
	}
	data, err := base64.StdEncoding.DecodeString(cmd.Data)
	if err != nil {
		return fmt.Errorf("decode input: %w", err)
	}
	if err := s.Input(data); err != nil {
		return err
	}
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleSessionResize(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
		SessionID string `json:"session_id"`
		Cols      int    `json:"cols"`
		Rows      int    `json:"rows"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	s := g.sessions.Get(cmd.SessionID)
	if s == nil {
		return fmt.Errorf("session %q not found", cmd.SessionID)
	}
	if g.cfg.CPURL == config.CPURLStaging {
		g.log.Info("session resize command", "session_id", cmd.SessionID, "cols", cmd.Cols, "rows", cmd.Rows)
	}
	if err := s.Resize(cmd.Cols, cmd.Rows); err != nil {
		return err
	}
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleSessionEnd(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	if err := g.sessions.End(cmd.SessionID); err != nil {
		return err
	}
	g.sendEvent(ctx, map[string]any{
		"type":       "session.ended",
		"session_id": cmd.SessionID,
	})
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleSessionAck(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
		SessionID string `json:"session_id"`
		Seq       uint64 `json:"seq"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	if cmd.SessionID == "" {
		return fmt.Errorf("session_id is required")
	}
	// Accepted for protocol compatibility; M1 replay behavior is snapshot-based.
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleSessionSnapshot(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	s := g.sessions.Get(cmd.SessionID)
	if s == nil {
		return fmt.Errorf("session %q not found", cmd.SessionID)
	}
	content, cols, rows, cursorX, cursorY, cursorVisible, err := s.Snapshot()
	if err != nil {
		return err
	}
	if g.cfg.CPURL == config.CPURLStaging {
		g.log.Info(
			"session snapshot",
			"session_id", cmd.SessionID,
			"cols", cols,
			"rows", rows,
			"cursor_x", cursorX,
			"cursor_y", cursorY,
			"cursor_visible", cursorVisible,
		)
	}
	content = trimSnapshotTail(content, maxSnapshotBytes)
	evt := map[string]any{
		"type":       "session.snapshot",
		"request_id": cmd.RequestID,
		"session_id": cmd.SessionID,
		"content":    content,
		"cols":       cols,
		"rows":       rows,
	}
	if cursorX >= 0 {
		evt["cursor_x"] = cursorX
	}
	if cursorY >= 0 {
		evt["cursor_y"] = cursorY
	}
	if cursorVisible == 0 {
		evt["cursor_visible"] = false
	} else if cursorVisible == 1 {
		evt["cursor_visible"] = true
	}
	g.sendEvent(ctx, evt)
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

// ----- SSH handlers -----

func (g *gateway) handleSSHAuthorize(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string     `json:"request_id"`
		PublicKey string     `json:"public_key"`
		Label     string     `json:"label"`
		ExpiresAt *time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	if err := g.sshMgr.Authorize(cmd.PublicKey, cmd.Label, cmd.ExpiresAt); err != nil {
		return err
	}
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleSSHRevoke(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID   string `json:"request_id"`
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	if err := g.sshMgr.Revoke(cmd.Fingerprint); err != nil {
		return err
	}
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleSSHList(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	entries, err := g.sshMgr.List()
	if err != nil {
		return err
	}
	keys := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		k := map[string]any{
			"fingerprint": e.Fingerprint,
			"label":       e.Label,
			"algorithm":   e.Algorithm,
		}
		if e.ExpiresAt != nil {
			k["expires_at"] = e.ExpiresAt.Format(time.RFC3339)
		}
		keys = append(keys, k)
	}
	g.sendEvent(ctx, map[string]any{
		"type":       "ssh.keys",
		"request_id": cmd.RequestID,
		"keys":       keys,
	})
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

// ----- File handlers -----

func (g *gateway) handleFileUploadBegin(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID   string `json:"request_id"`
		TransferID  string `json:"transfer_id"`
		DestPath    string `json:"dest_path"`
		Size        int64  `json:"size"`
		TotalChunks int    `json:"total_chunks"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	if err := g.files.UploadBegin(cmd.TransferID, cmd.DestPath, cmd.Size, cmd.TotalChunks); err != nil {
		return err
	}
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleFileUploadChunk(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID  string `json:"request_id"`
		TransferID string `json:"transfer_id"`
		Seq        int    `json:"seq"`
		Data       string `json:"data"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	if err := g.files.UploadChunk(cmd.TransferID, cmd.Seq, cmd.Data); err != nil {
		return err
	}
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleFileUploadEnd(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID  string `json:"request_id"`
		TransferID string `json:"transfer_id"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	if err := g.files.UploadEnd(cmd.TransferID); err != nil {
		return err
	}
	g.sendAck(ctx, cmd.RequestID, true, "")
	return nil
}

func (g *gateway) handleFileDownload(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID  string `json:"request_id"`
		TransferID string `json:"transfer_id"`
		Path       string `json:"path"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	go func() {
		if err := g.files.Download(ctx, cmd.TransferID, cmd.Path); err != nil {
			g.log.Error("file download failed", "err", err, "transfer_id", cmd.TransferID)
			g.sendAck(ctx, cmd.RequestID, false, err.Error())
			return
		}
		g.sendAck(ctx, cmd.RequestID, true, "")
	}()
	return nil
}

func (g *gateway) handleFileCancel(_ context.Context, raw json.RawMessage) error {
	var cmd struct {
		TransferID string `json:"transfer_id"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	g.files.Cancel(cmd.TransferID)
	return nil
}

// ----- Agent/update handlers -----

func (g *gateway) handleAgentsInstall(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
		Agent     string `json:"agent"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}

	// Acknowledge immediately so control-plane/test UI does not time out while
	// npm-based installs run for minutes on small VPS instances.
	g.sendAck(ctx, cmd.RequestID, true, "")

	go func() {
		version, err := agents.Install(agents.AgentName(cmd.Agent))
		if err != nil {
			// TODO: emit a schema-defined agent.install_failed event so clients can
			// surface async install failures without relying on gateway logs.
			g.log.Error("agent install failed", "agent", cmd.Agent, "request_id", cmd.RequestID, "err", err)
			return
		}
		g.sendEvent(ctx, map[string]any{
			"type":       "agent.installed",
			"request_id": cmd.RequestID,
			"agent":      cmd.Agent,
			"version":    version,
		})
	}()
	return nil
}

func (g *gateway) handleAgentsList(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}

	statuses := agents.ListStatus()
	items := make([]map[string]any, 0, len(statuses))
	for _, s := range statuses {
		item := map[string]any{
			"agent":     string(s.Agent),
			"binary":    s.Binary,
			"installed": s.Installed,
		}
		if s.Version != "" {
			item["version"] = s.Version
		}
		items = append(items, item)
	}

	g.sendEvent(ctx, map[string]any{
		"type":       "agents.status",
		"request_id": cmd.RequestID,
		"agents":     items,
	})
	return nil
}

func (g *gateway) handleWorkspaceList(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}

	folders, err := workspace.ListTopLevelFolders(g.workspaceRoot)
	if err != nil {
		return err
	}

	g.sendEvent(ctx, map[string]any{
		"type":       "workspace.folders",
		"request_id": cmd.RequestID,
		"folders":    folders,
	})
	return nil
}

func (g *gateway) handleGatewayUpdate(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID      string `json:"request_id"`
		URL            string `json:"url"`
		SHA256         string `json:"sha256"`
		Version        string `json:"version"`
		ReleaseBaseURL string `json:"release_base_url"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	if strings.TrimSpace(cmd.URL) == "" && strings.TrimSpace(cmd.Version) == "" {
		return fmt.Errorf("gateway.update requires either url+sha256 or version")
	}

	// Ack immediately once the updater job is accepted. The process is expected
	// to restart during a successful update, so waiting for a post-update ack is
	// inherently racy and makes the control-plane treat expected disconnects as
	// command failures.
	g.sendAck(ctx, cmd.RequestID, true, "")
	go func() {
		var err error
		if strings.TrimSpace(cmd.URL) != "" {
			err = g.updater.Update(cmd.URL, cmd.SHA256)
		} else {
			err = g.updater.UpdateRelease(cmd.ReleaseBaseURL, cmd.Version)
		}
		if err != nil {
			g.sendEvent(ctx, map[string]any{
				"type":       "gateway.update_failed",
				"request_id": cmd.RequestID,
				"error":      err.Error(),
			})
			return
		}
		// Best-effort: this may be lost if systemd replaces the process first.
		g.sendEvent(ctx, map[string]any{
			"type":       "gateway.updated",
			"request_id": cmd.RequestID,
			"version":    strings.TrimSpace(cmd.Version),
		})
	}()
	return nil
}

// ----- Background goroutines -----

// forwardOutput reads from outputCh and sends binary terminal frames over WS.
func (g *gateway) forwardOutput(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case chunk := <-g.outputCh:
			frame, err := encodeTerminalFrame(chunk.SessionID, chunk.Seq, chunk.Data)
			if err != nil {
				g.log.Warn("encode terminal frame failed", "err", err)
				continue
			}
			if err := g.wsClient.SendBinary(ctx, frame); err != nil {
				// Not connected – drop frame (output will be recovered via snapshot on reconnect)
				g.log.Debug("drop terminal frame (not connected)", "session", chunk.SessionID)
			}
		}
	}
}

// runHealthTicker sends gateway.health on the configured interval.
func (g *gateway) runHealthTicker(ctx context.Context) {
	// Warm up CPU baseline
	g.health.Collect()
	ticker := time.NewTicker(g.cfg.HealthInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.sendHealth(ctx)
		}
	}
}

func (g *gateway) runFileTransferPruner(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.files.PruneStale()
		}
	}
}

func (g *gateway) sendHealth(ctx context.Context) {
	m := g.health.Collect()
	activeSessions := g.sessions.List()
	sessions := make([]map[string]any, 0, len(activeSessions))
	for _, s := range activeSessions {
		sessions = append(sessions, map[string]any{
			"session_id":       s.SessionID,
			"last_activity_at": s.LastActivityAt.Format(time.RFC3339),
		})
	}
	g.sendEvent(ctx, map[string]any{
		"type":             "gateway.health",
		"gateway_id":       g.cfg.GatewayID,
		"timestamp":        m.Timestamp.Format(time.RFC3339),
		"cpu_percent":      m.CPUPercent,
		"ram_used_bytes":   m.RAMUsedBytes,
		"ram_total_bytes":  m.RAMTotalBytes,
		"disk_used_bytes":  m.DiskUsedBytes,
		"disk_total_bytes": m.DiskTotalBytes,
		"uptime_seconds":   m.UptimeSeconds,
		"active_sessions":  sessions,
	})
}

func (g *gateway) sendEvent(ctx context.Context, event map[string]any) {
	if _, ok := event["schema_version"]; !ok {
		event["schema_version"] = schemaVersion
	}
	_ = g.wsClient.SendJSON(ctx, event)
}

func extractRequestID(raw []byte) string {
	matches := requestIDRegexp.FindSubmatch(raw)
	if len(matches) != 2 {
		return ""
	}
	return string(matches[1])
}

func trimSnapshotTail(content string, maxBytes int) string {
	if maxBytes <= 0 || len(content) <= maxBytes {
		return content
	}

	tail := []byte(content[len(content)-maxBytes:])
	for len(tail) > 0 && !utf8.Valid(tail) {
		tail = tail[1:]
	}
	const prefix = "[snapshot truncated to recent output]\n"
	return prefix + string(tail)
}

// ----- Helpers -----

// encodeTerminalFrame packs PTY output into a binary protocol frame.
// Layout: [kind:1][session_id_len:1][session_id:N][seq:8][payload:M]
func encodeTerminalFrame(sessionID string, seq uint64, payload []byte) ([]byte, error) {
	idBytes := []byte(sessionID)
	if len(idBytes) > 255 {
		return nil, fmt.Errorf("session_id too long")
	}
	buf := make([]byte, 1+1+len(idBytes)+8+len(payload))
	offset := 0
	buf[offset] = 0x01
	offset++
	buf[offset] = byte(len(idBytes))
	offset++
	copy(buf[offset:], idBytes)
	offset += len(idBytes)
	for i := 7; i >= 0; i-- {
		buf[offset+i] = byte(seq)
		seq >>= 8
	}
	offset += 8
	copy(buf[offset:], payload)
	return buf, nil
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	switch level {
	case "debug":
		l = slog.LevelDebug
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}
