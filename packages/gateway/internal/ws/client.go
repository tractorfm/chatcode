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
	minBackoff = 1 * time.Second
	maxBackoff = 5 * time.Minute
	backoffMul = 2.0
)

// TextHandler is called for every incoming JSON text frame.
// The raw bytes are the full message; peek at "type" to dispatch.
type TextHandler func(ctx context.Context, msg json.RawMessage)

// BinaryHandler is called for every incoming binary frame.
type BinaryHandler func(ctx context.Context, data []byte)

// Client is a persistent WebSocket connection to the control plane.
type Client struct {
	url       string
	authToken string
	onText    TextHandler
	onBinary  BinaryHandler

	mu   sync.Mutex
	conn *websocket.Conn

	log *slog.Logger
}

// NewClient creates a Client. Call Run to start connecting.
func NewClient(url, authToken string, onText TextHandler, onBinary BinaryHandler, log *slog.Logger) *Client {
	return &Client{
		url:       url,
		authToken: authToken,
		onText:    onText,
		onBinary:  onBinary,
		log:       log,
	}
}

// Run connects and reconnects until ctx is cancelled. It blocks.
func (c *Client) Run(ctx context.Context) {
	backoff := minBackoff
	for {
		if err := c.connect(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			c.log.Warn("ws disconnected", "err", err, "retry_in", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(time.Duration(float64(backoff)*backoffMul), maxBackoff)
		} else {
			backoff = minBackoff
		}
	}
}

// connect dials, reads until error, then returns.
func (c *Client) connect(ctx context.Context) error {
	headers := http.Header{
		"Authorization": []string{"Bearer " + c.authToken},
	}
	conn, _, err := websocket.Dial(ctx, c.url, &websocket.DialOptions{
		HTTPHeader: headers,
	})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	c.setConn(conn)
	defer func() {
		c.setConn(nil)
		conn.CloseNow()
	}()

	c.log.Info("ws connected", "url", c.url)
	return c.readLoop(ctx, conn)
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

// SendJSON sends a JSON text frame. Safe to call concurrently.
func (c *Client) SendJSON(ctx context.Context, v any) error {
	conn := c.getConn()
	if conn == nil {
		return fmt.Errorf("not connected")
	}
	return wsjson.Write(ctx, conn, v)
}

// SendBinary sends a binary frame. Safe to call concurrently.
func (c *Client) SendBinary(ctx context.Context, data []byte) error {
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

// exponentialBackoff computes capped backoff for attempt n (0-indexed).
func exponentialBackoff(attempt int) time.Duration {
	d := time.Duration(float64(minBackoff) * math.Pow(backoffMul, float64(attempt)))
	if d > maxBackoff {
		d = maxBackoff
	}
	return d
}
