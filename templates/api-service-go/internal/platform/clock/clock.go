// Package clock is the one place the program asks what time it is.
//
// Why: services take a Clock so tests pin time instead of sleeping, and every
// timestamp is UTC truncated to microseconds, which is exactly what PostgreSQL
// stores. Without the truncation the in-memory fake and the real database would
// round-trip different values and the shared repository contract tests could
// not hold for both.
package clock

import (
	"sync"
	"time"
)

// Clock reports the current time.
type Clock interface {
	Now() time.Time
}

// System is the wall clock.
type System struct{}

// Now returns the current UTC time at microsecond precision.
func (System) Now() time.Time { return time.Now().UTC().Truncate(time.Microsecond) }

// Fake is a settable clock for tests. It is safe for concurrent use.
type Fake struct {
	mu sync.Mutex
	t  time.Time
}

// NewFake returns a Fake starting at t.
func NewFake(t time.Time) *Fake { return &Fake{t: t.UTC().Truncate(time.Microsecond)} }

// Now returns the fake time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

// Advance moves the fake time forward.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}
