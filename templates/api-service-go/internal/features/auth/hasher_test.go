package auth_test

import (
	"context"
	"strings"
	"testing"

	"example.com/api-service/internal/features/auth"
)

// cheapParams keep the suite fast; the production defaults are pinned by
// TestDefaultParametersArePinned and exercised once by TestDefaultHasherRoundTrip.
func cheapParams() auth.Argon2Params {
	return auth.Argon2Params{Memory: 8, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}
}

// The cost parameters are a security decision: changing them must be deliberate
// and visible in review. OWASP minimum is m=19456 KiB, t=2, p=1.
func TestDefaultParametersArePinned(t *testing.T) {
	t.Parallel()
	got := auth.DefaultArgon2Params()
	want := auth.Argon2Params{Memory: 65536, Iterations: 3, Parallelism: 1, SaltLen: 16, KeyLen: 32}
	if got != want {
		t.Fatalf("default Argon2id parameters changed: %+v, want %+v", got, want)
	}
	if got.Memory < 19456 || got.Iterations < 2 {
		t.Fatalf("parameters are below the OWASP minimum: %+v", got)
	}
}

func TestDefaultHasherRoundTrip(t *testing.T) {
	t.Parallel()
	h := auth.NewArgon2idHasher(auth.DefaultArgon2Params(), 1)
	enc, err := h.Hash(context.Background(), "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(enc, "$argon2id$v=19$m=65536,t=3,p=1$") {
		t.Fatalf("encoded hash = %q", enc)
	}
	ok, rehash, err := h.Verify(context.Background(), "correct horse battery staple", enc)
	if err != nil || !ok || rehash {
		t.Fatalf("verify = %v, %v, %v", ok, rehash, err)
	}
}

func TestHashVerify(t *testing.T) {
	t.Parallel()
	h := auth.NewArgon2idHasher(cheapParams(), 0)
	ctx := context.Background()
	enc, err := h.Hash(ctx, "a long enough password")
	if err != nil {
		t.Fatal(err)
	}
	if enc2, _ := h.Hash(ctx, "a long enough password"); enc == enc2 {
		t.Fatal("two hashes of one password must differ (random salt)")
	}
	if strings.Contains(enc, "a long enough password") {
		t.Fatal("the hash contains the password")
	}
	for _, tt := range []struct {
		pw   string
		want bool
	}{{"a long enough password", true}, {"a long enough passwore", false}, {"", false}, {"A long enough password", false}} {
		ok, _, err := h.Verify(ctx, tt.pw, enc)
		if err != nil || ok != tt.want {
			t.Errorf("Verify(%q) = %v, %v; want %v", tt.pw, ok, err, tt.want)
		}
	}
}

func TestVerifyFlagsWeakerStoredHashes(t *testing.T) {
	t.Parallel()
	old := auth.NewArgon2idHasher(cheapParams(), 0)
	enc, _ := old.Hash(context.Background(), "a long enough password")

	stronger := cheapParams()
	stronger.Iterations = 2
	current := auth.NewArgon2idHasher(stronger, 0)
	ok, rehash, err := current.Verify(context.Background(), "a long enough password", enc)
	if err != nil || !ok || !rehash {
		t.Fatalf("verify = %v, rehash=%v, %v; want ok with rehash", ok, rehash, err)
	}
}

func TestVerifyRejectsMalformedAndHostileHashes(t *testing.T) {
	t.Parallel()
	h := auth.NewArgon2idHasher(cheapParams(), 0)
	for _, bad := range []string{
		"",
		"plaintext",
		"$argon2i$v=19$m=8,t=1,p=1$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg",
		"$argon2id$v=18$m=8,t=1,p=1$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg",
		"$argon2id$v=19$m=8,t=1$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg",
		"$argon2id$v=19$m=0,t=1,p=1$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg",
		"$argon2id$v=19$m=8,t=0,p=1$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg",
		"$argon2id$v=19$m=8,t=1,p=0$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg",
		"$argon2id$v=19$m=4000000000,t=1,p=1$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg", // would allocate gigabytes
		"$argon2id$v=19$m=8,t=4000000000,p=1$c2FsdHNhbHRzYWx0$MDEyMzQ1Njc4OWFiY2RlZg",
		"$argon2id$v=19$m=8,t=1,p=1$$MDEyMzQ1Njc4OWFiY2RlZg",
		"$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHRzYWx0$",
		"$argon2id$v=19$m=8,t=1,p=1$!!!$MDEyMzQ1Njc4OWFiY2RlZg",
	} {
		if ok, _, err := h.Verify(context.Background(), "x", bad); ok || err == nil {
			t.Errorf("Verify accepted or ignored malformed hash %q (ok=%v, err=%v)", bad, ok, err)
		}
	}
}
