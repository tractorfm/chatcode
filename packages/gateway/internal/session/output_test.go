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
