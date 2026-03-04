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
	got, redraw := diff(old, newVal)
	if got != "line4\n" {
		t.Fatalf("diff sliding window = %q, want %q", got, "line4\n")
	}
	if redraw {
		t.Fatalf("diff sliding window unexpectedly requested redraw")
	}
}

func TestDiffInPlaceLineUpdate(t *testing.T) {
	old := "progress 10%\n"
	newVal := "progress 11%\n"
	want := "\x1b[H\x1b[2J" + newVal
	got, redraw := diff(old, newVal)
	if got != want {
		t.Fatalf("diff in-place update = %q, want %q", got, want)
	}
	if !redraw {
		t.Fatalf("diff in-place update should request redraw")
	}
}
