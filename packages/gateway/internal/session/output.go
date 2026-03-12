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
	batchInterval                = 50 * time.Millisecond
	pathologicalPollInterval     = 250 * time.Millisecond
	cursorPollInterval           = 150 * time.Millisecond
	bufferCapacity               = 64
	maxPayload                   = 16 * 1024 // 16KB per frame
	fullRedrawPrefix             = "\x1b[0m\x1b[H\x1b[2J"
	pathologicalRedrawBytes      = 4 * maxPayload
	pathologicalRedrawBurstLimit = 3
	pathologicalRedrawWindow     = 1 * time.Second
	pathologicalRedrawCooldown   = 500 * time.Millisecond
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
	timer  *time.Timer

	lastRawContent        string
	lastContent           string
	lastCursorX           int
	lastCursorY           int
	lastCursorV           int
	lastCursorAt          time.Time
	redrawBurstCount      int
	redrawWindowStart     time.Time
	redrawSuppressedUntil time.Time
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
	c.timer = time.NewTimer(batchInterval)

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
	if c.timer != nil {
		c.timer.Stop()
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
		case <-c.timer.C:
			c.resetTimer(c.processTick())
		}
	}
}

func (c *outputCapturer) processTick() time.Duration {
	tickAt := time.Now()
	rawContent, err := c.capturePane()
	if err != nil {
		return c.captureInterval(tickAt)
	}
	if rawContent == c.lastRawContent {
		return c.processCursorOnlyTick(tickAt)
	}

	cursorX, cursorY, cursorV, cursorErr := c.captureCursor()
	if cursorErr == nil {
		c.lastCursorAt = tickAt
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
		return c.captureInterval(tickAt)
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
	if redraw && c.shouldSuppressPathologicalRedraw(len(delta), tickAt) {
		return c.captureInterval(tickAt)
	}

	c.emitDelta(delta)
	return c.captureInterval(tickAt)
}

func (c *outputCapturer) processCursorOnlyTick(tickAt time.Time) time.Duration {
	// Some full-screen apps move cursor without changing text content.
	// Emit cursor-only control sequence so remote terminal stays aligned.
	if !c.lastCursorAt.IsZero() && tickAt.Sub(c.lastCursorAt) < cursorPollInterval {
		return c.captureInterval(tickAt)
	}
	cursorX, cursorY, cursorV, cursorErr := c.captureCursor()
	if cursorErr != nil {
		return c.captureInterval(tickAt)
	}
	c.lastCursorAt = tickAt
	moved := cursorX != c.lastCursorX || cursorY != c.lastCursorY
	visCtrl := c.cursorVisibilityControl(cursorV)
	if !moved && visCtrl == "" {
		return c.captureInterval(tickAt)
	}
	c.lastCursorX = cursorX
	c.lastCursorY = cursorY
	c.lastCursorV = cursorV
	delta := visCtrl
	if moved {
		delta += cursorMove(cursorX, cursorY)
	}
	c.emitDelta(delta)
	return c.captureInterval(tickAt)
}

func (c *outputCapturer) shouldSuppressPathologicalRedraw(deltaBytes int, now time.Time) bool {
	if deltaBytes < pathologicalRedrawBytes {
		if !c.redrawWindowStart.IsZero() && now.Sub(c.redrawWindowStart) > pathologicalRedrawWindow {
			c.redrawWindowStart = time.Time{}
			c.redrawBurstCount = 0
		}
		return false
	}

	if c.redrawWindowStart.IsZero() || now.Sub(c.redrawWindowStart) > pathologicalRedrawWindow {
		c.redrawWindowStart = now
		c.redrawBurstCount = 1
		return false
	}

	if now.Before(c.redrawSuppressedUntil) {
		return true
	}

	c.redrawBurstCount++
	if c.redrawBurstCount >= pathologicalRedrawBurstLimit {
		c.redrawWindowStart = now
		c.redrawBurstCount = pathologicalRedrawBurstLimit - 1
		c.redrawSuppressedUntil = now.Add(pathologicalRedrawCooldown)
	}
	return false
}

func (c *outputCapturer) captureInterval(now time.Time) time.Duration {
	if now.Before(c.redrawSuppressedUntil) {
		return pathologicalPollInterval
	}
	return batchInterval
}

func (c *outputCapturer) resetTimer(interval time.Duration) {
	if c.timer == nil {
		return
	}
	if !c.timer.Stop() {
		select {
		case <-c.timer.C:
		default:
		}
	}
	c.timer.Reset(interval)
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
