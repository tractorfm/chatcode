// Command mockcp is a minimal mock control plane for gateway development.
//
// It accepts gateway WebSocket connections, logs all received messages,
// and lets you send commands to the gateway by typing JSON on stdin.
//
// Usage:
//
//	make mock-cp       # starts on :8080
//	MOCKCP_ADDR=:9090 go run ./cmd/mockcp
//
// Then run the gateway pointing at it:
//
//	GATEWAY_CP_URL=ws://localhost:8080/gw/connect \
//	  GATEWAY_ID=gw-dev \
//	  GATEWAY_AUTH_TOKEN=devtoken \
//	  ./gateway
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

func main() {
	addr := os.Getenv("MOCKCP_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	srv := &mockCP{log: log}

	mux := http.NewServeMux()
	mux.HandleFunc("/gw/connect", srv.handleConnect)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	log.Info("mock control plane listening", "addr", addr)
	log.Info("connect gateway with GATEWAY_CP_URL=ws://localhost" + addr + "/gw/connect")

	go srv.stdinSender()

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Error("server error", "err", err)
		os.Exit(1)
	}
}

type mockCP struct {
	log  *slog.Logger
	mu   sync.Mutex
	conn *websocket.Conn
}

func (m *mockCP) handleConnect(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		m.log.Error("accept failed", "err", err)
		return
	}
	defer conn.CloseNow()

	m.mu.Lock()
	m.conn = conn
	m.mu.Unlock()

	m.log.Info("gateway connected", "remote", r.RemoteAddr)
	fmt.Fprintf(os.Stderr, "\n[mock-cp] Gateway connected. Type JSON to send commands (e.g. {\"type\":\"ssh.list\",\"request_id\":\"r1\"})\n> ")

	ctx := r.Context()
	for {
		msgType, data, err := conn.Read(ctx)
		if err != nil {
			m.log.Info("gateway disconnected", "err", err)
			break
		}
		switch msgType {
		case websocket.MessageText:
			m.logTextFrame(data)
		case websocket.MessageBinary:
			m.logBinaryFrame(data)
		}
	}

	m.mu.Lock()
	if m.conn == conn {
		m.conn = nil
	}
	m.mu.Unlock()
}

func (m *mockCP) logTextFrame(data []byte) {
	var pretty map[string]any
	if err := json.Unmarshal(data, &pretty); err != nil {
		m.log.Info("← text frame (unparseable)", "raw", string(data))
		return
	}
	prettyJSON, _ := json.MarshalIndent(pretty, "  ", "  ")
	fmt.Fprintf(os.Stderr, "\n[mock-cp] ← %s\n> ", prettyJSON)
}

func (m *mockCP) logBinaryFrame(data []byte) {
	if len(data) < 2 {
		m.log.Info("← binary frame (too short)", "len", len(data))
		return
	}
	kind := data[0]
	if kind == 0x01 {
		idLen := int(data[1])
		if len(data) >= 2+idLen+8 {
			sessionID := string(data[2 : 2+idLen])
			var seq uint64
			for i := 0; i < 8; i++ {
				seq = (seq << 8) | uint64(data[2+idLen+i])
			}
			payload := data[2+idLen+8:]
			fmt.Fprintf(os.Stderr, "\n[mock-cp] ← terminal[%s] seq=%d payload=%dB: %q\n> ",
				sessionID, seq, len(payload), truncate(string(payload), 80))
			return
		}
	}
	fmt.Fprintf(os.Stderr, "\n[mock-cp] ← binary frame kind=0x%02x len=%d\n> ", kind, len(data))
}

// stdinSender reads JSON from stdin and sends it to the connected gateway.
func (m *mockCP) stdinSender() {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			fmt.Fprint(os.Stderr, "> ")
			continue
		}

		// Auto-add request_id if missing
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			fmt.Fprintf(os.Stderr, "[mock-cp] invalid JSON: %v\n> ", err)
			continue
		}
		if _, ok := obj["request_id"]; !ok {
			obj["request_id"] = fmt.Sprintf("req-%d", time.Now().UnixMilli())
		}

		m.mu.Lock()
		conn := m.conn
		m.mu.Unlock()

		if conn == nil {
			fmt.Fprint(os.Stderr, "[mock-cp] no gateway connected\n> ")
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := wsjson.Write(ctx, conn, obj)
		cancel()

		if err != nil {
			fmt.Fprintf(os.Stderr, "[mock-cp] send error: %v\n> ", err)
		} else {
			prettyJSON, _ := json.MarshalIndent(obj, "  ", "  ")
			fmt.Fprintf(os.Stderr, "[mock-cp] → %s\n> ", prettyJSON)
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
