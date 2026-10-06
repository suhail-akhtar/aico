// Package ratelimit is a per-key token bucket built on golang.org/x/time/rate.
//
// Why in-process: a single replica (or a small fleet behind a load balancer
// that already spreads clients) needs a brake on brute force and runaway
// clients, not a distributed quota. The limit is per replica, which is stated in
// docs/ARCHITECTURE.md; the growth step is a gateway or Redis/Valkey-backed
// limiter once the replicas must agree.
//
// Time is injected so tests are deterministic. Idle keys are evicted by Sweep so
// an attacker rotating source addresses cannot grow the map without bound; Run
// calls Sweep on a ticker until its context ends.
package ratelimit

import (
	"context"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type visitor struct {
	lim  *rate.Limiter
	seen time.Time
}

// Limiter hands out tokens per key.
type Limiter struct {
	mu       sync.Mutex
	rate     rate.Limit
	burst    int
	idle     time.Duration
	now      func() time.Time
	visitors map[string]*visitor
}

// New returns a Limiter allowing rps sustained requests per second per key with
// the given burst. Keys unused for idle are forgotten by Sweep. now may be nil.
func New(rps float64, burst int, idle time.Duration, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{rate: rate.Limit(rps), burst: burst, idle: idle, now: now, visitors: map[string]*visitor{}}
}

// Allow takes one token for key. When none is available it returns false and
// how long the caller should wait.
func (l *Limiter) Allow(key string) (ok bool, retryAfter time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	v, found := l.visitors[key]
	if !found {
		v = &visitor{lim: rate.NewLimiter(l.rate, l.burst)}
		l.visitors[key] = v
	}
	v.seen = now

	res := v.lim.ReserveN(now, 1)
	if !res.OK() {
		return false, time.Second
	}
	if delay := res.DelayFrom(now); delay > 0 {
		res.CancelAt(now) // do not charge a request that was refused
		return false, delay
	}
	return true, 0
}

// Sweep forgets keys idle for longer than the configured idle time.
func (l *Limiter) Sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := l.now().Add(-l.idle)
	for k, v := range l.visitors {
		if v.seen.Before(cutoff) {
			delete(l.visitors, k)
		}
	}
}

// Len is the number of tracked keys (for tests and metrics).
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.visitors)
}

// Run sweeps every interval until ctx is cancelled.
func (l *Limiter) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			l.Sweep()
		}
	}
}
