// Package health collects system metrics: CPU, RAM, disk, uptime.
// On Linux it reads /proc/stat, /proc/meminfo, and uses syscall.Statfs.
// On other platforms it returns zero values (useful for dev on macOS).
package health

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Metrics holds a snapshot of system health.
type Metrics struct {
	Timestamp      time.Time
	CPUPercent     float64
	RAMUsedBytes   uint64
	RAMTotalBytes  uint64
	DiskUsedBytes  uint64
	DiskTotalBytes uint64
	UptimeSeconds  int64
}

// Collector gathers system metrics.
type Collector struct {
	diskPath string // path to measure disk usage on (typically "/")

	// previous CPU sample for delta calculation
	prevTotal uint64
	prevIdle  uint64
}

// NewCollector creates a Collector measuring disk at diskPath (usually "/").
func NewCollector(diskPath string) *Collector {
	return &Collector{diskPath: diskPath}
}

// Collect returns current system metrics.
func (c *Collector) Collect() Metrics {
	m := Metrics{Timestamp: time.Now()}
	m.CPUPercent = c.cpuPercent()
	m.RAMUsedBytes, m.RAMTotalBytes = readMemInfo()
	m.DiskUsedBytes, m.DiskTotalBytes = diskUsage(c.diskPath)
	m.UptimeSeconds = readUptime()
	return m
}

// cpuPercent returns CPU usage since the last call (0–100).
// Returns 0 on the first call (no previous sample).
func (c *Collector) cpuPercent() float64 {
	total, idle, err := readCPUStat()
	if err != nil {
		return 0
	}

	deltaTot := total - c.prevTotal
	deltaIdle := idle - c.prevIdle
	c.prevTotal = total
	c.prevIdle = idle

	if deltaTot == 0 {
		return 0
	}
	return float64(deltaTot-deltaIdle) / float64(deltaTot) * 100.0
}

// readCPUStat reads the first line of /proc/stat and returns (total, idle).
func readCPUStat() (total, idle uint64, err error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		// cpu  user nice system idle iowait irq softirq steal guest guest_nice
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return 0, 0, fmt.Errorf("unexpected cpu line: %q", line)
		}
		var vals []uint64
		for _, f := range fields[1:] {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				return 0, 0, err
			}
			vals = append(vals, v)
			total += v
		}
		idle = vals[3] // 4th field (index 3): idle
		return total, idle, nil
	}
	return 0, 0, fmt.Errorf("/proc/stat: cpu line not found")
}

// readMemInfo parses /proc/meminfo for MemTotal and MemAvailable.
func readMemInfo() (used, total uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	vals := make(map[string]uint64)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		parts := strings.Fields(scanner.Text())
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		v, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		vals[key] = v * 1024 // /proc/meminfo values are in kB
	}

	total = vals["MemTotal"]
	available := vals["MemAvailable"]
	if total > available {
		used = total - available
	}
	return used, total
}

// diskUsage returns (used, total) bytes for the filesystem containing path.
func diskUsage(path string) (used, total uint64) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0
	}
	total = stat.Blocks * uint64(stat.Bsize)
	avail := stat.Bavail * uint64(stat.Bsize)
	if total > avail {
		used = total - avail
	}
	return used, total
}

// readUptime parses /proc/uptime for system uptime in seconds.
func readUptime() int64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	f, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return int64(f)
}
