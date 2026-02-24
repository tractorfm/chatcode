package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

// mockServer starts a WebSocket test server and records received messages.
type mockServer struct {
	srv      *httptest.Server
	received []json.RawMessage
	mu       sync.Mutex
	accept   chan *websocket.Conn
}

func newMockServer(t *testing.T) *mockServer {
	t.Helper()
	ms := &mockServer{
		accept: make(chan *websocket.Conn, 1),
	}
	ms.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			return
		}
		ms.accept <- conn
		// drain
		ctx := r.Context()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			ms.mu.Lock()
			ms.received = append(ms.received, json.RawMessage(data))
			ms.mu.Unlock()
		}
	}))
	return ms
}

func (ms *mockServer) wsURL() string {
	return "ws" + strings.TrimPrefix(ms.srv.URL, "http")
}

func (ms *mockServer) close() {
	ms.srv.Close()
}

func (ms *mockServer) received_() []json.RawMessage {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	out := make([]json.RawMessage, len(ms.received))
	copy(out, ms.received)
	return out
}

func TestClientConnectsAndSendsHello(t *testing.T) {
	ms := newMockServer(t)
	defer ms.close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := NewClient(
		ms.wsURL(), "test-token",
		func(ctx context.Context, msg json.RawMessage) {},
		nil,
		slog.Default(),
	)

	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		client.Run(ctx)
	}()

	// Wait for server to accept connection
	select {
	case conn := <-ms.accept:
		// Send a ping from server to trigger onText handler
		if err := wsjson.Write(ctx, conn, map[string]any{"type": "ping"}); err != nil {
			t.Fatalf("server write: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timeout waiting for connection")
	}

	// Send a message from client
	time.Sleep(100 * time.Millisecond)
	if err := client.SendJSON(ctx, map[string]any{"type": "gateway.hello", "gateway_id": "gw-test"}); err != nil {
		t.Fatalf("SendJSON: %v", err)
	}

	// Wait a bit for messages to arrive
	time.Sleep(200 * time.Millisecond)

	msgs := ms.received_()
	if len(msgs) == 0 {
		t.Fatal("expected at least one message from client")
	}

	var found bool
	for _, msg := range msgs {
		var m map[string]any
		if err := json.Unmarshal(msg, &m); err == nil {
			if m["type"] == "gateway.hello" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("did not receive gateway.hello from client")
	}

	cancel()
	<-runDone
}

func TestClientReconnects(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping reconnect test in short mode")
	}

	connectCount := 0
	var mu sync.Mutex

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		connectCount++
		count := connectCount
		mu.Unlock()

		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		// First connection: close immediately to force reconnect
		if count == 1 {
			conn.Close(websocket.StatusGoingAway, "test disconnect")
			return
		}
		// Second connection: keep open
		ctx := r.Context()
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client := NewClient(wsURL, "token", nil, nil, slog.Default())
	go client.Run(ctx)

	// Give time for reconnect
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		c := connectCount
		mu.Unlock()
		if c >= 2 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	mu.Lock()
	final := connectCount
	mu.Unlock()
	if final < 2 {
		t.Fatalf("expected at least 2 connections (reconnect), got %d", final)
	}

	cancel()
}

func TestExponentialBackoff(t *testing.T) {
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{0, 1 * time.Second},
		{1, 2 * time.Second},
		{2, 4 * time.Second},
		{10, maxBackoff},
	}
	for _, tc := range cases {
		got := exponentialBackoff(tc.attempt)
		if got != tc.want {
			t.Errorf("attempt %d: got %v, want %v", tc.attempt, got, tc.want)
		}
	}
}

func TestClientConcurrentSendsAreSerialized(t *testing.T) {
	ms := newMockServer(t)
	defer ms.close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client := NewClient(ms.wsURL(), "token", nil, nil, slog.Default())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		client.Run(ctx)
	}()

	select {
	case <-ms.accept:
	case <-ctx.Done():
		t.Fatal("timeout waiting for connection")
	}
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if client.Connected() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !client.Connected() {
		t.Fatal("client did not report connected state")
	}

	const sends = 40
	var wg sync.WaitGroup
	wg.Add(sends)
	for i := 0; i < sends; i++ {
		i := i
		go func() {
			defer wg.Done()
			var err error
			for attempt := 0; attempt < 5; attempt++ {
				err = client.SendJSON(ctx, map[string]any{"type": "t", "i": i})
				if err == nil {
					return
				}
				if !strings.Contains(err.Error(), "not connected") {
					t.Errorf("SendJSON(%d): %v", i, err)
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
			if err != nil {
				t.Errorf("SendJSON(%d): %v", i, err)
			}
		}()
	}
	wg.Wait()
	time.Sleep(200 * time.Millisecond)

	if got := len(ms.received_()); got < sends {
		t.Fatalf("received %d messages, want at least %d", got, sends)
	}

	cancel()
	<-runDone
}
