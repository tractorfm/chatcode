package health

import (
	"runtime"
	"testing"
	"time"
)

func TestCollect(t *testing.T) {
	c := NewCollector("/")
	// First call: establishes baseline CPU sample
	c.Collect()
	// Small delay so there's a delta
	time.Sleep(100 * time.Millisecond)
	m := c.Collect()

	if m.Timestamp.IsZero() {
		t.Error("Timestamp should not be zero")
	}

	if runtime.GOOS == "linux" {
		// On Linux we can assert more strongly
		if m.RAMTotalBytes == 0 {
			t.Error("RAMTotalBytes should be non-zero on Linux")
		}
		if m.DiskTotalBytes == 0 {
			t.Error("DiskTotalBytes should be non-zero on Linux")
		}
		if m.UptimeSeconds == 0 {
			t.Error("UptimeSeconds should be non-zero on Linux")
		}
		if m.CPUPercent < 0 || m.CPUPercent > 100 {
			t.Errorf("CPUPercent out of range: %f", m.CPUPercent)
		}
	} else {
		// On macOS /proc doesn't exist; values will be 0 – just verify no panic
		t.Logf("Non-Linux platform (%s): skipping /proc assertions", runtime.GOOS)
	}
}

func TestCollectDisk(t *testing.T) {
	c := NewCollector("/")
	m := c.Collect()
	// Disk should be non-zero on any real filesystem
	if m.DiskTotalBytes == 0 {
		t.Skip("disk metrics not available (may be in container)")
	}
	if m.DiskUsedBytes > m.DiskTotalBytes {
		t.Errorf("used (%d) > total (%d)", m.DiskUsedBytes, m.DiskTotalBytes)
	}
}
