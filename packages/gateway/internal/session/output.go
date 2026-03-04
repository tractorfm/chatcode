package session

import (
	"context"
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

			delta := diff(c.lastContent, content)
			c.lastContent = content

			if len(delta) == 0 {
				continue
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
	return string(out), nil
}

// diff returns the bytes in b that are not a suffix match of a.
// For the MVP this is a simple heuristic: return content added since last snapshot.
// In practice tmux capture-pane returns the full visible buffer, so we return
// everything if it changed, and rely on the xterm.js terminal at the client to
// handle re-renders correctly. The seq number ensures ordering.
func diff(old, new string) string {
	if old == "" {
		return new
	}
	if old == new {
		return ""
	}

	if strings.HasPrefix(new, old) {
		return new[len(old):]
	}

	// Sliding window case: viewport scrolled; keep only unseen tail.
	overlap := longestSuffixPrefixOverlap(old, new)
	if overlap > 0 {
		return new[overlap:]
	}

	// In-place updates (e.g. progress bars) cannot be represented as a suffix
	// diff from capture-pane snapshots, so redraw the visible pane content.
	return "\x1b[H\x1b[2J" + new
}

func longestSuffixPrefixOverlap(old, new string) int {
	max := len(old)
	if len(new) < max {
		max = len(new)
	}
	for size := max; size > 0; size-- {
		if old[len(old)-size:] == new[:size] {
			return size
		}
	}
	return 0
}
