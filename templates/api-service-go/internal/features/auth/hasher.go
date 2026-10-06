package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"runtime"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Hasher hashes and verifies passwords. The interface lets tests use cheap
// parameters and lets a deployment swap the algorithm without touching Service.
type Hasher interface {
	Hash(ctx context.Context, password string) (string, error)
	// Verify reports whether password matches encoded, and whether encoded was
	// produced with weaker parameters than the hasher's current ones.
	Verify(ctx context.Context, password, encoded string) (ok, needsRehash bool, err error)
}

// Argon2Params are the Argon2id cost parameters. Memory is in KiB.
type Argon2Params struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	SaltLen     uint32
	KeyLen      uint32
}

// DefaultArgon2Params is m=64 MiB, t=3, p=1: above the OWASP minimum
// (m=19 MiB, t=2, p=1) because RAM is cheap and cracking hardware is not. A
// test pins these values so a change is deliberate and visible in review.
func DefaultArgon2Params() Argon2Params {
	return Argon2Params{Memory: 65536, Iterations: 3, Parallelism: 1, SaltLen: 16, KeyLen: 32}
}

// Argon2idHasher implements Hasher. It caps concurrent hashes: each one holds
// Memory KiB, so an unbounded burst of logins could exhaust the container's
// memory long before the CPU is busy. Excess callers wait (and honour ctx).
type Argon2idHasher struct {
	params Argon2Params
	sem    chan struct{}
}

// NewArgon2idHasher returns a hasher with the given cost. maxConcurrent <= 0
// picks min(max(GOMAXPROCS, 2), 8).
func NewArgon2idHasher(p Argon2Params, maxConcurrent int) *Argon2idHasher {
	if maxConcurrent <= 0 {
		maxConcurrent = min(max(runtime.GOMAXPROCS(0), 2), 8)
	}
	return &Argon2idHasher{params: p, sem: make(chan struct{}, maxConcurrent)}
}

func (h *Argon2idHasher) acquire(ctx context.Context) (release func(), err error) {
	select {
	case h.sem <- struct{}{}:
		return func() { <-h.sem }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("waiting to hash a password: %w", ctx.Err())
	}
}

// Hash returns a PHC-format string: $argon2id$v=19$m=..,t=..,p=..$salt$hash.
func (h *Argon2idHasher) Hash(ctx context.Context, password string) (string, error) {
	release, err := h.acquire(ctx)
	if err != nil {
		return "", err
	}
	defer release()

	salt := make([]byte, h.params.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, h.params.Iterations, h.params.Memory, h.params.Parallelism, h.params.KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version,
		h.params.Memory, h.params.Iterations, h.params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// Verify checks password against encoded in constant time.
func (h *Argon2idHasher) Verify(ctx context.Context, password, encoded string) (ok, needsRehash bool, err error) {
	p, salt, want, err := parseHash(encoded)
	if err != nil {
		return false, false, err
	}
	release, err := h.acquire(ctx)
	if err != nil {
		return false, false, err
	}
	defer release()

	got := argon2.IDKey([]byte(password), salt, p.Iterations, p.Memory, p.Parallelism, uint32(len(want))) //nolint:gosec // len(want) is bounded by parseHash
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return false, false, nil
	}
	cur := h.params
	return true, p.Memory != cur.Memory || p.Iterations != cur.Iterations || p.Parallelism != cur.Parallelism || uint32(len(want)) != cur.KeyLen, nil //nolint:gosec // bounded by parseHash
}

var errBadHash = errors.New("auth: stored password hash is malformed")

// Bounds on parsed parameters: a corrupted or attacker-supplied hash must not
// be able to make Verify allocate gigabytes.
const (
	maxParseMemory      = 1 << 21 // 2 GiB in KiB
	maxParseIterations  = 64
	maxParseParallelism = 64
	maxParseKeyLen      = 128
)

func parseHash(encoded string) (p Argon2Params, salt, key []byte, err error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return p, nil, nil, errBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return p, nil, nil, errBadHash
	}
	var parallelism uint32
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Iterations, &parallelism); err != nil {
		return p, nil, nil, errBadHash
	}
	if p.Memory == 0 || p.Memory > maxParseMemory || p.Iterations == 0 || p.Iterations > maxParseIterations ||
		parallelism == 0 || parallelism > maxParseParallelism {
		return p, nil, nil, errBadHash
	}
	p.Parallelism = uint8(parallelism)
	if salt, err = base64.RawStdEncoding.DecodeString(parts[4]); err != nil || len(salt) < 8 {
		return p, nil, nil, errBadHash
	}
	if key, err = base64.RawStdEncoding.DecodeString(parts[5]); err != nil || len(key) < 16 || len(key) > maxParseKeyLen {
		return p, nil, nil, errBadHash
	}
	return p, salt, key, nil
}
