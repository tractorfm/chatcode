// Package ws implements the persistent WebSocket client connecting the gateway
// to the control plane. It handles auto-reconnect with exponential backoff,
// hello/health framing, and dispatches incoming frames to registered handlers.
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sync"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

const (
	minBackoff           = 1 * time.Second
	maxBackoff           = 30 * time.Second
	backoffMul           = 2.0
	defaultReadLimitByte = 2 << 20 // 2 MiB
	backoffResetAfter    = 30 * time.Second
	dialTimeout          = 15 * time.Second
	pingInterval         = 20 * time.Second
	pingTimeout          = 10 * time.Second
)

// TextHandler is called for every incoming JSON text frame.
// The raw bytes are the full message; peek at "type" to dispatch.
type TextHandler func(ctx context.Context, msg json.RawMessage)

// BinaryHandler is called for every incoming binary frame.
type BinaryHandler func(ctx context.Context, data []byte)

// Target identifies which control-plane endpoint this client should dial.
type Target uint8

const (
	TargetProd Target = iota
	TargetStaging
	TargetSelfHost
)

// SelfHostGatewayWSURL is optionally injected at build time for self-hosted
// releases. Example:
//
//	-X github.com/tractorfm/chatcode/packages/gateway/internal/ws.SelfHostGatewayWSURL=wss://cp.example.com/gw/connect
var SelfHostGatewayWSURL = ""

// Client is a persistent WebSocket connection to the control plane.
type Client struct {
	gatewayID string
	authToken string
	target    Target
	onText    TextHandler
	onBinary  BinaryHandler
	dialURL   func() string

	mu   sync.Mutex
	conn *websocket.Conn

	writeMu sync.Mutex

	log *slog.Logger
}

// NewClient creates a Client. Call Run to start connecting.
func NewClient(
	gatewayID, authToken string,
	target Target,
	onText TextHandler,
	onBinary BinaryHandler,
	log *slog.Logger,
) *Client {
	c := &Client{
		gatewayID: gatewayID,
		authToken: authToken,
		target:    target,
		onText:    onText,
		onBinary:  onBinary,
		log:       log,
	}
	c.dialURL = c.defaultDialURL
	return c
}

func (c *Client) defaultDialURL() string {
	switch c.target {
	case TargetStaging:
		return "wss://cp.staging.chatcode.dev/gw/connect"
	case TargetSelfHost:
		return SelfHostGatewayWSURL
	default:
		return "wss://cp.chatcode.dev/gw/connect"
	}
}

func (c *Client) connectHeaders() http.Header {
	headers := http.Header{
		"Authorization": []string{"Bearer " + c.authToken},
	}
	if c.gatewayID != "" {
		headers.Set("X-Gateway-Id", c.gatewayID)
	}
	return headers
}

// Run connects and reconnects until ctx is cancelled. It blocks.
func (c *Client) Run(ctx context.Context) {
	backoff := minBackoff
	for {
		connectedFor, err := c.connect(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}

			backoff = nextBackoff(backoff, connectedFor)
			c.log.Warn("ws disconnected", "err", err, "retry_in", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
		}
	}
}

// connect dials, reads until error, then returns.
func (c *Client) connect(ctx context.Context) (time.Duration, error) {
	wsURL := c.dialURL()
	if wsURL == "" {
		return 0, fmt.Errorf("control-plane websocket URL is empty for target %d", c.target)
	}

	dialCtx, cancelDial := context.WithTimeout(ctx, dialTimeout)
	defer cancelDial()

	conn, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		HTTPHeader: c.connectHeaders(),
	})
	if err != nil {
		return 0, fmt.Errorf("dial: %w", err)
	}
	connectedAt := time.Now()
	conn.SetReadLimit(defaultReadLimitByte)
	c.setConn(conn)

	pingCtx, cancelPing := context.WithCancel(ctx)
	go c.pingLoop(pingCtx, conn)

	defer func() {
		cancelPing()
		c.setConn(nil)
		conn.CloseNow()
	}()

	c.log.Info("ws connected", "url", wsURL)
	err = c.readLoop(ctx, conn)
	return time.Since(connectedAt), err
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		msgType, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		switch msgType {
		case websocket.MessageText:
			if c.onText != nil {
				c.onText(ctx, json.RawMessage(data))
			}
		case websocket.MessageBinary:
			if c.onBinary != nil {
				c.onBinary(ctx, data)
			}
		}
	}
}

func (c *Client) pingLoop(ctx context.Context, conn *websocket.Conn) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				c.log.Warn("ws ping failed", "err", err)
				_ = conn.Close(websocket.StatusGoingAway, "ping failed")
				return
			}
		}
	}
}

// SendJSON sends a JSON text frame. Safe to call concurrently.
func (c *Client) SendJSON(ctx context.Context, v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	conn := c.getConn()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	return wsjson.Write(ctx, conn, v)
}

// SendBinary sends a binary frame. Safe to call concurrently.
func (c *Client) SendBinary(ctx context.Context, data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	conn := c.getConn()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	return conn.Write(ctx, websocket.MessageBinary, data)
}

// Connected reports whether there is an active connection.
func (c *Client) Connected() bool {
	return c.getConn() != nil
}

func (c *Client) setConn(conn *websocket.Conn) {
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
}

func (c *Client) getConn() *websocket.Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn
}

// backoff helpers

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func nextBackoff(current time.Duration, connectedFor time.Duration) time.Duration {
	if connectedFor >= backoffResetAfter {
		return minBackoff
	}
	return min(time.Duration(float64(current)*backoffMul), maxBackoff)
}

// exponentialBackoff computes capped backoff for attempt n (0-indexed).
func exponentialBackoff(attempt int) time.Duration {
	d := time.Duration(float64(minBackoff) * math.Pow(backoffMul, float64(attempt)))
	if d > maxBackoff {
		d = maxBackoff
	}
	return d
}
