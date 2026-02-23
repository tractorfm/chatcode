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
	"runtime"
	"syscall"
	"time"

	"github.com/tractorfm/chatcode/packages/gateway/internal/agents"
	"github.com/tractorfm/chatcode/packages/gateway/internal/config"
	"github.com/tractorfm/chatcode/packages/gateway/internal/files"
	"github.com/tractorfm/chatcode/packages/gateway/internal/health"
	"github.com/tractorfm/chatcode/packages/gateway/internal/session"
	sshkeys "github.com/tractorfm/chatcode/packages/gateway/internal/ssh"
	"github.com/tractorfm/chatcode/packages/gateway/internal/update"
	"github.com/tractorfm/chatcode/packages/gateway/internal/ws"
)

// Version and BuildTime are set via ldflags at build time.
var (
	Version   = "dev"
	BuildTime = "unknown"
)

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
		sshMgr:   sshkeys.NewManager(cfg.SSHKeysFile),
		health:   health.NewCollector("/"),
		updater:  update.NewUpdater(cfg.BinaryPath, log),
	}

	// Output channel: session output chunks → WS sender goroutine
	g.outputCh = make(chan session.OutputChunk, 256)

	// Start SSH expiry watcher
	sshkeys.StartExpiryWatcher(ctx, g.sshMgr, 5*time.Minute, log)

	// Create file handler (sender will be wired after WS client is set up)
	// We use a late-binding sender so the WS client can be nil during startup
	workspaceRoot, err := os.UserHomeDir()
	if err != nil || workspaceRoot == "" {
		workspaceRoot = "/home/vibe"
	}
	g.files = files.NewHandler(cfg.TempDir, workspaceRoot, func(ctx context.Context, v any) error {
		return g.wsClient.SendJSON(ctx, v)
	})

	// Create WS client
	g.wsClient = ws.NewClient(
		cfg.CPURL,
		cfg.AuthToken,
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
	hello := map[string]any{
		"type":       "gateway.hello",
		"gateway_id": g.cfg.GatewayID,
		"version":    Version,
		"hostname":   hostname,
		"go_version": runtime.Version(),
	}
	if err := g.wsClient.SendJSON(ctx, hello); err != nil {
		g.log.Warn("send hello failed", "err", err)
	} else {
		g.log.Info("sent gateway.hello")
	}
}

func (g *gateway) sendSnapshots(ctx context.Context) {
	for _, s := range g.sessions.List() {
		sess := g.sessions.Get(s.SessionID)
		if sess == nil {
			continue
		}
		content, cols, rows, err := sess.Snapshot()
		if err != nil {
			continue
		}
		g.wsClient.SendJSON(ctx, map[string]any{
			"type":       "session.snapshot",
			"session_id": s.SessionID,
			"content":    content,
			"cols":       cols,
			"rows":       rows,
		})
	}
}

// onTextFrame dispatches incoming JSON commands from the control plane.
func (g *gateway) onTextFrame(ctx context.Context, raw json.RawMessage) {
	var base struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		g.log.Warn("unparseable text frame", "err", err)
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
		"type":       "ack",
		"request_id": requestID,
		"ok":         ok,
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

	s, err := g.sessions.Create(opts)
	if err != nil {
		return err
	}
	_ = s

	g.wsClient.SendJSON(ctx, map[string]any{
		"type":       "session.started",
		"request_id": cmd.RequestID,
		"session_id": cmd.SessionID,
	})
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
	g.wsClient.SendJSON(ctx, map[string]any{
		"type":       "session.ended",
		"session_id": cmd.SessionID,
	})
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
	content, cols, rows, err := s.Snapshot()
	if err != nil {
		return err
	}
	g.wsClient.SendJSON(ctx, map[string]any{
		"type":       "session.snapshot",
		"request_id": cmd.RequestID,
		"session_id": cmd.SessionID,
		"content":    content,
		"cols":       cols,
		"rows":       rows,
	})
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
	g.wsClient.SendJSON(ctx, map[string]any{
		"type":       "ssh.keys",
		"request_id": cmd.RequestID,
		"keys":       keys,
	})
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
		}
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
	go func() {
		version, err := agents.Install(agents.AgentName(cmd.Agent))
		if err != nil {
			g.sendAck(ctx, cmd.RequestID, false, err.Error())
			return
		}
		g.wsClient.SendJSON(ctx, map[string]any{
			"type":       "agent.installed",
			"request_id": cmd.RequestID,
			"agent":      cmd.Agent,
			"version":    version,
		})
	}()
	return nil
}

func (g *gateway) handleGatewayUpdate(ctx context.Context, raw json.RawMessage) error {
	var cmd struct {
		RequestID string `json:"request_id"`
		URL       string `json:"url"`
		SHA256    string `json:"sha256"`
		Version   string `json:"version"`
	}
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return err
	}
	go func() {
		if err := g.updater.Update(cmd.URL, cmd.SHA256); err != nil {
			g.sendAck(ctx, cmd.RequestID, false, err.Error())
			return
		}
		// If we get here the process is about to be replaced by systemd.
		// Send updated event as a best-effort.
		g.wsClient.SendJSON(ctx, map[string]any{
			"type":       "gateway.updated",
			"request_id": cmd.RequestID,
			"version":    cmd.Version,
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
	g.wsClient.SendJSON(ctx, map[string]any{
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
