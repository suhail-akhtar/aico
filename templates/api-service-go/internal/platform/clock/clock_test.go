package clock_test

import (
	"testing"
	"time"

	"example.com/api-service/internal/platform/clock"
)

func TestSystemIsUTCMicroseconds(t *testing.T) {
	t.Parallel()
	now := clock.System{}.Now()
	if now.Location() != time.UTC {
		t.Errorf("location = %v, want UTC", now.Location())
	}
	if now.Nanosecond()%1000 != 0 {
		t.Errorf("%d ns: not truncated to microseconds", now.Nanosecond())
	}
}

func TestFake(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 10, 6, 12, 0, 0, 123456789, time.FixedZone("x", 3600))
	f := clock.NewFake(start)
	if got := f.Now(); !got.Equal(start.Truncate(time.Microsecond)) || got.Location() != time.UTC {
		t.Fatalf("Now = %v", got)
	}
	f.Advance(90 * time.Second)
	if got := f.Now().Sub(start.Truncate(time.Microsecond)); got != 90*time.Second {
		t.Fatalf("advanced by %v", got)
	}
}
