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
	capturePaneFn  func() (string, error)
	captureStateFn func() (paneState, error)

	lastRawContent        string
	lastContent           string
	lastCursorX           int
	lastCursorY           int
	lastCursorV           int
	lastAlternate         int
	lastCursorAt          time.Time
	redrawBurstCount      int
	redrawWindowStart     time.Time
	redrawSuppressedUntil time.Time
}

type paneState struct {
	cursorX     int
	cursorY     int
	cursorV     int
	alternateOn bool
}

func newOutputCapturer(
	tmuxName, sessionID string,
	seq *uint64, lastAct *int64,
	outCh chan OutputChunk,
) *outputCapturer {
	c := &outputCapturer{
		tmuxName:     tmuxName,
		sessionID:    sessionID,
		seq:          seq,
		lastAct:      lastAct,
		outCh:        outCh,
		lastCursorX:  -1,
		lastCursorY:  -1,
		lastCursorV:  -1,
		lastAlternate: -1,
		lastCursorAt: time.Time{},
	}
	c.capturePaneFn = c.capturePane
	c.captureStateFn = c.captureState
	return c
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
	if rawContent, err := c.capturePaneFn(); err == nil {
		c.lastRawContent = rawContent
		c.lastContent = rawContent
	}
	if state, err := c.captureStateFn(); err == nil {
		c.lastCursorX = state.cursorX
		c.lastCursorY = state.cursorY
		c.lastCursorV = state.cursorV
		c.lastAlternate = boolToInt(state.alternateOn)
		c.lastCursorAt = time.Now()
		c.lastContent = normalizeCapturedContent(c.lastContent, state.cursorY, state.cursorV)
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
	rawContent, err := c.capturePaneFn()
	if err != nil {
		return c.captureInterval(tickAt)
	}
	if rawContent == c.lastRawContent {
		return c.processCursorOnlyTick(tickAt)
	}

	state, stateErr := c.captureStateFn()
	if stateErr == nil {
		c.lastCursorAt = tickAt
	}

	content := rawContent
	if stateErr == nil {
		content = normalizeCapturedContent(content, state.cursorY, state.cursorV)
	} else {
		content = normalizeCapturedContent(content, -1, -1)
	}
	delta, redraw := diff(c.lastContent, content)
	c.lastRawContent = rawContent
	c.lastContent = content
	altCtrl := ""
	alternateTransition := false
	if stateErr == nil {
		altCtrl = c.alternateBufferControl(state.alternateOn)
		alternateTransition = altCtrl != ""
	}

	if alternateTransition {
		delta = fullRedrawPrefix + content
		redraw = true
	}

	if len(delta) == 0 {
		if stateErr == nil {
			if visCtrl := c.cursorVisibilityControl(state.cursorV); visCtrl != "" {
				c.lastCursorV = state.cursorV
				c.emitDelta(visCtrl)
			}
			c.lastAlternate = boolToInt(state.alternateOn)
		}
		return c.captureInterval(tickAt)
	}

	if stateErr == nil {
		if visCtrl := c.cursorVisibilityControl(state.cursorV); visCtrl != "" {
			if redraw {
				delta = visCtrl + delta
			} else {
				delta += visCtrl
			}
			c.lastCursorV = state.cursorV
		}
	}
	if altCtrl != "" {
		delta = altCtrl + delta
	}
	if redraw && stateErr == nil {
		c.lastCursorX = state.cursorX
		c.lastCursorY = state.cursorY
		delta += cursorMove(state.cursorX, state.cursorY)
	}
	if stateErr == nil {
		c.lastAlternate = boolToInt(state.alternateOn)
	}
	if redraw && !alternateTransition && c.shouldSuppressPathologicalRedraw(len(delta), tickAt) {
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
	state, stateErr := c.captureStateFn()
	if stateErr != nil {
		return c.captureInterval(tickAt)
	}
	c.lastCursorAt = tickAt
	moved := state.cursorX != c.lastCursorX || state.cursorY != c.lastCursorY
	visCtrl := c.cursorVisibilityControl(state.cursorV)
	altCtrl := c.alternateBufferControl(state.alternateOn)
	alternateTransition := altCtrl != ""
	if !alternateTransition && !moved && visCtrl == "" {
		return c.captureInterval(tickAt)
	}
	c.lastCursorX = state.cursorX
	c.lastCursorY = state.cursorY
	c.lastCursorV = state.cursorV
	c.lastAlternate = boolToInt(state.alternateOn)
	delta := ""
	if alternateTransition {
		delta = altCtrl
		if visCtrl != "" {
			delta += visCtrl
		}
		delta += fullRedrawPrefix + c.lastContent
		delta += cursorMove(state.cursorX, state.cursorY)
	} else {
		delta = visCtrl
		if moved {
			delta += cursorMove(state.cursorX, state.cursorY)
		}
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

func (c *outputCapturer) captureState() (paneState, error) {
	out, err := exec.Command(
		"tmux", "display-message", "-t", c.tmuxName, "-p", "#{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on}",
	).Output()
	if err != nil {
		return paneState{}, err
	}
	return parsePaneStateOutput(string(out))
}

func parsePaneStateOutput(out string) (paneState, error) {
	var state paneState
	var alternateInt int
	if _, err := fmt.Sscanf(strings.TrimSpace(out), "%d %d %d %d", &state.cursorX, &state.cursorY, &state.cursorV, &alternateInt); err != nil {
		return paneState{}, err
	}
	state.alternateOn = alternateInt == 1
	return state, nil
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

func (c *outputCapturer) alternateBufferControl(alternateOn bool) string {
	if c.lastAlternate < 0 {
		return ""
	}
	if c.lastAlternate == boolToInt(alternateOn) {
		return ""
	}
	if alternateOn {
		return "\x1b[?1049h"
	}
	return "\x1b[?1049l"
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
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
