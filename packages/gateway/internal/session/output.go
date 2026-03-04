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
	batchInterval  = 50 * time.Millisecond
	bufferCapacity = 64
	maxPayload     = 16 * 1024 // 16KB per frame
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

	lastContent string
}

func newOutputCapturer(
	tmuxName, sessionID string,
	seq *uint64, lastAct *int64,
	outCh chan OutputChunk,
) *outputCapturer {
	return &outputCapturer{
		tmuxName:  tmuxName,
		sessionID: sessionID,
		seq:       seq,
		lastAct:   lastAct,
		outCh:     outCh,
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
	if content, err := c.capturePane(); err == nil {
		c.lastContent = content
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
			content, err := c.capturePane()
			if err != nil || content == c.lastContent {
				continue
			}

			delta, redraw := diff(c.lastContent, content)
			c.lastContent = content

			if len(delta) == 0 {
				continue
			}
			if redraw {
				if cursorX, cursorY, err := c.captureCursor(); err == nil {
					delta += fmt.Sprintf("\x1b[%d;%dH", cursorY+1, cursorX+1)
				}
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
	}
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
	out, err := exec.Command("tmux", "capture-pane", "-e", "-t", c.tmuxName, "-p").Output()
	if err != nil {
		return "", err
	}
	// tmux capture-pane -p always appends a trailing newline; drop it so
	// redraw payloads do not add a phantom extra row in terminal consumers.
	return strings.TrimSuffix(string(out), "\n"), nil
}

func (c *outputCapturer) captureCursor() (int, int, error) {
	out, err := exec.Command(
		"tmux", "display-message", "-t", c.tmuxName, "-p", "#{cursor_x} #{cursor_y}",
	).Output()
	if err != nil {
		return 0, 0, err
	}
	var cursorX, cursorY int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(out)), "%d %d", &cursorX, &cursorY); err != nil {
		return 0, 0, err
	}
	return cursorX, cursorY, nil
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

	// Sliding window case: viewport scrolled; keep only unseen tail.
	overlap := longestSuffixPrefixOverlap(old, new)
	if overlap > 0 {
		return new[overlap:], false
	}

	// In-place updates (e.g. progress bars) cannot be represented as a suffix
	// diff from capture-pane snapshots, so redraw the visible pane content.
	// This assumes a VT-compatible terminal consumer (xterm.js in MVP).
	return "\x1b[H\x1b[2J" + new, true
}

func longestSuffixPrefixOverlap(old, new string) int {
	// O(n): longest prefix(new) that is also suffix(old).
	// Build KMP prefix function for: new + \x00 + old.
	sep := "\x00"
	combined := new + sep + old
	pi := make([]int, len(combined))
	for i := 1; i < len(combined); i++ {
		j := pi[i-1]
		for j > 0 && combined[i] != combined[j] {
			j = pi[j-1]
		}
		if combined[i] == combined[j] {
			j++
		}
		pi[i] = j
	}
	overlap := pi[len(combined)-1]
	if overlap > len(new) {
		return len(new)
	}
	return overlap
}
