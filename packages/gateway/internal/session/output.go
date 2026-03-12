package session

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"
)

const (
	batchInterval      = 50 * time.Millisecond
	cursorPollInterval = 150 * time.Millisecond
	bufferCapacity     = 64
	maxPayload         = 16 * 1024 // 16KB per frame
	fullRedrawPrefix   = "\x1b[0m\x1b[H\x1b[2J"
)

// outputCapturer reads tmux pipe-pane output and batches it into OutputChunks.
type outputCapturer struct {
	tmuxName  string
	sessionID string
	seq       *uint64
	lastAct   *int64
	outCh     chan OutputChunk

	cancel context.CancelFunc
	buf    []byte
	ticker *time.Ticker

	lastRawContent string
	lastContent    string
	lastCursorX    int
	lastCursorY    int
	lastCursorV    int
	lastCursorAt   time.Time
}

func newOutputCapturer(
	tmuxName, sessionID string,
	seq *uint64, lastAct *int64,
	outCh chan OutputChunk,
) *outputCapturer {
	return &outputCapturer{
		tmuxName:     tmuxName,
		sessionID:    sessionID,
		seq:          seq,
		lastAct:      lastAct,
		outCh:        outCh,
		lastCursorX:  -1,
		lastCursorY:  -1,
		lastCursorV:  -1,
		lastCursorAt: time.Time{},
	}
}

// start begins capturing output from the tmux session using pipe-pane.
// tmux pipe-pane pipes all pane output to a command; we use `cat` to a named pipe.
// A simpler approach for the MVP: poll capture-pane -p on a ticker.
func (c *outputCapturer) start() {
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.ticker = time.NewTicker(batchInterval)

	// Seed initial content so browser's initial snapshot is not duplicated
	// by the first capture tick after websocket connect/reconnect.
	if rawContent, err := c.capturePane(); err == nil {
		c.lastRawContent = rawContent
		c.lastContent = rawContent
	}
	if cursorX, cursorY, cursorV, err := c.captureCursor(); err == nil {
		c.lastCursorX = cursorX
		c.lastCursorY = cursorY
		c.lastCursorV = cursorV
		c.lastCursorAt = time.Now()
		c.lastContent = normalizeCapturedContent(c.lastContent, cursorY, cursorV)
	}
	go c.pollLoop(ctx)
}

func (c *outputCapturer) stop() {
	if c.cancel != nil {
		c.cancel()
	}
	if c.ticker != nil {
		c.ticker.Stop()
	}
}

// pollLoop uses tmux capture-pane to read incremental output.
// We track the last captured content to emit only deltas.
// This is a simple, reliable approach for the MVP.
func (c *outputCapturer) pollLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.ticker.C:
			rawContent, err := c.capturePane()
			if err != nil {
				continue
			}
			if rawContent == c.lastRawContent {
				// Some full-screen apps move cursor without changing text content.
				// Emit cursor-only control sequence so remote terminal stays aligned.
				if !c.lastCursorAt.IsZero() && time.Since(c.lastCursorAt) < cursorPollInterval {
					continue
				}
				cursorX, cursorY, cursorV, cursorErr := c.captureCursor()
				if cursorErr != nil {
					continue
				}
				c.lastCursorAt = time.Now()
				moved := cursorX != c.lastCursorX || cursorY != c.lastCursorY
				visCtrl := c.cursorVisibilityControl(cursorV)
				if !moved && visCtrl == "" {
					continue
				}
				c.lastCursorX = cursorX
				c.lastCursorY = cursorY
				c.lastCursorV = cursorV
				delta := visCtrl
				if moved {
					delta += cursorMove(cursorX, cursorY)
				}
				c.emitDelta(delta)
				continue
			}

			cursorX, cursorY, cursorV, cursorErr := c.captureCursor()
			if cursorErr == nil {
				c.lastCursorAt = time.Now()
			}
			content := rawContent
			if cursorErr == nil {
				content = normalizeCapturedContent(content, cursorY, cursorV)
			} else {
				content = normalizeCapturedContent(content, -1, -1)
			}
			delta, redraw := diff(c.lastContent, content)
			c.lastRawContent = rawContent
			c.lastContent = content

			if len(delta) == 0 {
				if cursorErr == nil {
					if visCtrl := c.cursorVisibilityControl(cursorV); visCtrl != "" {
						c.lastCursorV = cursorV
						c.emitDelta(visCtrl)
					}
				}
				continue
			}

			if cursorErr == nil {
				if visCtrl := c.cursorVisibilityControl(cursorV); visCtrl != "" {
					if redraw {
						delta = visCtrl + delta
					} else {
						delta += visCtrl
					}
					c.lastCursorV = cursorV
				}
			}
			if redraw && cursorErr == nil {
				c.lastCursorX = cursorX
				c.lastCursorY = cursorY
				delta += cursorMove(cursorX, cursorY)
			}

			c.emitDelta(delta)
		}
	}
}

func (c *outputCapturer) emitDelta(delta string) {
	if len(delta) == 0 {
		return
	}
	atomic.StoreInt64(c.lastAct, time.Now().UnixNano())

	// Split into ≤maxPayload chunks
	for len(delta) > 0 {
		chunk := delta
		if len(chunk) > maxPayload {
			chunk = delta[:maxPayload]
		}
		delta = delta[len(chunk):]

		seq := atomic.AddUint64(c.seq, 1) - 1
		payload := OutputChunk{
			SessionID: c.sessionID,
			Seq:       seq,
			Data:      []byte(chunk),
		}

		enqueueLatest(c.outCh, payload)
	}
}

func cursorMove(cursorX, cursorY int) string {
	return fmt.Sprintf("\x1b[%d;%dH", cursorY+1, cursorX+1)
}

func enqueueLatest(outCh chan OutputChunk, payload OutputChunk) {
	select {
	case outCh <- payload:
		return
	default:
		// Full queue: drop oldest queued frame so newest output wins.
	}

	select {
	case <-outCh:
	default:
	}

	select {
	case outCh <- payload:
	default:
	}
}

func (c *outputCapturer) capturePane() (string, error) {
	out, err := exec.Command("tmux", "capture-pane", "-e", "-N", "-t", c.tmuxName, "-p").Output()
	if err != nil {
		return "", err
	}
	// tmux capture-pane -p always appends a trailing newline; drop it so
	// redraw payloads do not add a phantom extra row in terminal consumers.
	return stripOSC8Hyperlinks(strings.TrimSuffix(string(out), "\n")), nil
}

func (c *outputCapturer) captureCursor() (int, int, int, error) {
	out, err := exec.Command(
		"tmux", "display-message", "-t", c.tmuxName, "-p", "#{cursor_x} #{cursor_y} #{cursor_flag}",
	).Output()
	if err != nil {
		return 0, 0, 0, err
	}
	var cursorX, cursorY, cursorV int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(out)), "%d %d %d", &cursorX, &cursorY, &cursorV); err != nil {
		return 0, 0, 0, err
	}
	return cursorX, cursorY, cursorV, nil
}

func (c *outputCapturer) cursorVisibilityControl(cursorVisible int) string {
	if cursorVisible != 0 && cursorVisible != 1 {
		return ""
	}
	if c.lastCursorV == cursorVisible {
		return ""
	}
	if cursorVisible == 0 {
		return "\x1b[?25l"
	}
	return "\x1b[?25h"
}

func normalizeCapturedContent(content string, cursorY int, cursorVisible int) string {
	lines := strings.Split(content, "\n")
	keepTrailing := -1
	if cursorVisible == 1 && cursorY >= 0 && cursorY < len(lines) {
		keepTrailing = cursorY
	}
	for i, line := range lines {
		if i == keepTrailing {
			continue
		}
		lines[i] = strings.TrimRight(line, " ")
	}
	return strings.Join(lines, "\n")
}

// diff returns the bytes in b that are not a suffix match of a.
// For the MVP this is a simple heuristic: return content added since last snapshot.
// In practice tmux capture-pane returns the full visible buffer, so we return
// everything if it changed, and rely on the xterm.js terminal at the client to
// handle re-renders correctly. The seq number ensures ordering.
func diff(old, new string) (string, bool) {
	if old == "" {
		return new, false
	}
	if old == new {
		return "", false
	}

	if strings.HasPrefix(new, old) {
		return new[len(old):], false
	}

	// Any non-append change is treated as in-place update and rendered as full
	// viewport redraw. This avoids duplicated/misaligned output for dynamic UIs.
	return fullRedrawPrefix + new, true
}
