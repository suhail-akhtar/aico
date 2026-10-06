package ratelimit_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"example.com/api-service/internal/platform/ratelimit"
)

type fakeNow struct {
	mu sync.Mutex
	t  time.Time
}

func (f *fakeNow) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *fakeNow) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

func TestBurstThenRefuseThenRefill(t *testing.T) {
	t.Parallel()
	now := &fakeNow{t: time.Unix(1_700_000_000, 0)}
	l := ratelimit.New(1, 3, time.Minute, now.Now) // 1 per second, burst 3

	for i := range 3 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("request %d inside the burst was refused", i)
		}
	}
	ok, wait := l.Allow("a")
	if ok {
		t.Fatal("the fourth request must be refused")
	}
	if wait <= 0 || wait > time.Second {
		t.Fatalf("retry-after = %v, want within (0, 1s]", wait)
	}
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("a different key has its own budget")
	}

	now.Advance(time.Second)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("one token should have refilled after a second")
	}
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("only one token refilled")
	}
}

func TestRefusedRequestsAreNotCharged(t *testing.T) {
	t.Parallel()
	now := &fakeNow{t: time.Unix(1_700_000_000, 0)}
	l := ratelimit.New(1, 1, time.Minute, now.Now)
	l.Allow("a")
	for range 50 { // hammering while refused must not push the next allowed time further away
		l.Allow("a")
	}
	now.Advance(time.Second)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("refused requests were charged: the bucket did not refill on schedule")
	}
}

func TestSweepForgetsIdleKeys(t *testing.T) {
	t.Parallel()
	now := &fakeNow{t: time.Unix(1_700_000_000, 0)}
	l := ratelimit.New(1, 1, time.Minute, now.Now)
	l.Allow("old")
	now.Advance(2 * time.Minute)
	l.Allow("fresh")
	l.Sweep()
	if l.Len() != 1 {
		t.Fatalf("tracked keys = %d, want 1", l.Len())
	}
}

func TestRunSweepsAndStops(t *testing.T) {
	t.Parallel()
	now := &fakeNow{t: time.Unix(1_700_000_000, 0)}
	l := ratelimit.New(1, 1, time.Millisecond, now.Now)
	l.Allow("x")
	now.Advance(time.Hour)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { l.Run(ctx, 5*time.Millisecond); close(done) }()
	deadline := time.After(5 * time.Second)
	for l.Len() != 0 {
		select {
		case <-deadline:
			t.Fatal("Run never swept the idle key")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop when its context ended")
	}
}

func TestNilClockUsesWallTime(t *testing.T) {
	t.Parallel()
	l := ratelimit.New(100, 1, time.Minute, nil)
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("first request must be allowed")
	}
}
