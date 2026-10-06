package auth

import (
	"context"
	"errors"
	"testing"
)

// An internal test: it fills the hasher's concurrency slots directly so the
// "all slots busy" state is deterministic instead of a race against the CPU.
func TestHasherGivesUpWaitingForASlotWhenContextEnds(t *testing.T) {
	t.Parallel()
	h := NewArgon2idHasher(Argon2Params{Memory: 8, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}, 1)
	h.sem <- struct{}{} // the only slot is taken

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.Hash(ctx, "pw"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Hash with all slots busy and a cancelled context: %v", err)
	}
	valid := "$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg"
	if _, _, err := h.Verify(ctx, "pw", valid); !errors.Is(err, context.Canceled) {
		t.Fatalf("Verify with all slots busy and a cancelled context: %v", err)
	}

	<-h.sem // free the slot: the hasher works again
	if _, err := h.Hash(context.Background(), "pw"); err != nil {
		t.Fatalf("Hash after the slot was freed: %v", err)
	}
}

func TestDefaultConcurrencyIsBounded(t *testing.T) {
	t.Parallel()
	if c := cap(NewArgon2idHasher(DefaultArgon2Params(), 0).sem); c < 2 || c > 8 {
		t.Fatalf("default concurrency = %d, want 2..8", c)
	}
}
