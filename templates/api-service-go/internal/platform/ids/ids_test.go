package ids_test

import (
	"sync"
	"testing"
	"time"

	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/ids"
)

func TestNewIsValidUUIDv7(t *testing.T) {
	t.Parallel()
	g := ids.NewGenerator(clock.System{})
	id := g.New()
	if !ids.Valid(id) {
		t.Fatalf("%q is not a canonical UUID", id)
	}
	if id[14] != '7' {
		t.Errorf("%q: version nibble = %c, want 7", id, id[14])
	}
	if v := id[19]; v != '8' && v != '9' && v != 'a' && v != 'b' {
		t.Errorf("%q: variant nibble = %c, want 8, 9, a or b", id, v)
	}
}

func TestStrictlyIncreasingEvenWithFrozenAndBackwardsClock(t *testing.T) {
	t.Parallel()
	fake := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	g := ids.NewGenerator(fake)
	prev := ""
	for i := range 10_000 { // more than 4096, so the counter overflows into the next millisecond
		if i == 5000 {
			fake.Advance(-time.Hour) // the clock stepping backwards must not reorder ids
		}
		id := g.New()
		if id <= prev {
			t.Fatalf("id %d (%s) is not greater than the previous (%s)", i, id, prev)
		}
		prev = id
	}
}

func TestUniqueUnderConcurrency(t *testing.T) {
	t.Parallel()
	g := ids.NewGenerator(clock.System{})
	var mu sync.Mutex
	seen := map[string]bool{}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 500 {
				id := g.New()
				mu.Lock()
				if seen[id] {
					t.Errorf("duplicate id %s", id)
				}
				seen[id] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
}

func TestValid(t *testing.T) {
	t.Parallel()
	tests := []struct {
		in   string
		want bool
	}{
		{"0199a8c4-3f6e-7b21-8c3d-0123456789ab", true},
		{ids.MaxID, true},
		{"", false},
		{"not-a-uuid", false},
		{"0199A8C4-3F6E-7B21-8C3D-0123456789AB", false}, // uppercase is not canonical
		{"0199a8c43f6e-7b21-8c3d-0123456789ab0", false},
		{"0199a8c4-3f6e-7b21-8c3d-0123456789a'", false},
		{"0199a8c4-3f6e-7b21-8c3d-0123456789abc", false},
		{"0199a8c4_3f6e_7b21_8c3d_0123456789ab", false},
	}
	for _, tt := range tests {
		if got := ids.Valid(tt.in); got != tt.want {
			t.Errorf("Valid(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}
