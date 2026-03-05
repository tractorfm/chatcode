package session

import "testing"

func TestEnqueueLatestWhenQueueNotFull(t *testing.T) {
	ch := make(chan OutputChunk, 2)
	payload := OutputChunk{SessionID: "s1", Seq: 1, Data: []byte("a")}

	enqueueLatest(ch, payload)

	got := <-ch
	if got.Seq != payload.Seq {
		t.Fatalf("seq = %d, want %d", got.Seq, payload.Seq)
	}
}

func TestEnqueueLatestDropsOldestWhenFull(t *testing.T) {
	ch := make(chan OutputChunk, 1)
	oldest := OutputChunk{SessionID: "s1", Seq: 1, Data: []byte("old")}
	newest := OutputChunk{SessionID: "s1", Seq: 2, Data: []byte("new")}

	ch <- oldest
	enqueueLatest(ch, newest)

	got := <-ch
	if got.Seq != newest.Seq {
		t.Fatalf("seq = %d, want %d", got.Seq, newest.Seq)
	}
}

func TestDiffAppend(t *testing.T) {
	old := "line1\nline2\n"
	newVal := "line1\nline2\nline3\n"
	got, redraw := diff(old, newVal)
	if got != "line3\n" {
		t.Fatalf("diff append = %q, want %q", got, "line3\n")
	}
	if redraw {
		t.Fatalf("diff append unexpectedly requested redraw")
	}
}

func TestDiffSlidingWindow(t *testing.T) {
	old := "line1\nline2\nline3\n"
	newVal := "line2\nline3\nline4\n"
	want := fullRedrawPrefix + newVal
	got, redraw := diff(old, newVal)
	if got != want {
		t.Fatalf("diff sliding window = %q, want %q", got, want)
	}
	if !redraw {
		t.Fatalf("diff sliding window should request redraw")
	}
}

func TestDiffInPlaceLineUpdate(t *testing.T) {
	old := "progress 10%\n"
	newVal := "progress 11%\n"
	want := fullRedrawPrefix + newVal
	got, redraw := diff(old, newVal)
	if got != want {
		t.Fatalf("diff in-place update = %q, want %q", got, want)
	}
	if !redraw {
		t.Fatalf("diff in-place update should request redraw")
	}
}

func TestCursorMove(t *testing.T) {
	got := cursorMove(3, 10)
	want := "\x1b[11;4H"
	if got != want {
		t.Fatalf("cursorMove = %q, want %q", got, want)
	}
}

func TestCursorVisibilityControl(t *testing.T) {
	c := &outputCapturer{lastCursorV: -1}
	if got := c.cursorVisibilityControl(0); got != "\x1b[?25l" {
		t.Fatalf("cursorVisibilityControl(0) = %q", got)
	}
	c.lastCursorV = 0
	if got := c.cursorVisibilityControl(0); got != "" {
		t.Fatalf("cursorVisibilityControl(0) should be empty, got %q", got)
	}
	if got := c.cursorVisibilityControl(1); got != "\x1b[?25h" {
		t.Fatalf("cursorVisibilityControl(1) = %q", got)
	}
}

func TestNormalizeCapturedContentKeepsCursorLineTrailingSpaces(t *testing.T) {
	content := "a  \nb   \n"
	got := normalizeCapturedContent(content, 1, 1)
	want := "a\nb   \n"
	if got != want {
		t.Fatalf("normalizeCapturedContent = %q, want %q", got, want)
	}
}

func TestNormalizeCapturedContentTrimsAllWhenCursorHidden(t *testing.T) {
	content := "a  \nb   \n"
	got := normalizeCapturedContent(content, 1, 0)
	want := "a\nb\n"
	if got != want {
		t.Fatalf("normalizeCapturedContent hidden = %q, want %q", got, want)
	}
}
