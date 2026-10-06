// Package ids generates identifiers: UUIDv7 (RFC 9562), time-ordered.
//
// Why app-side UUIDv7 and not gen_random_uuid() or serial integers:
//   - ids are known before the INSERT, so the in-memory fake and PostgreSQL
//     behave the same and a service can return the id without a round trip;
//   - they sort by creation time, so "newest first" keyset pagination is just
//     `ORDER BY id DESC` on the primary key, with no second index and no
//     created_at tie-breaking;
//   - they do not leak row counts the way integers do.
//
// The 12-bit counter (RFC 9562 method 1) keeps ids strictly increasing inside
// one process even within a millisecond or when the clock steps back, which is
// what makes the keyset cursor safe. Across processes ordering is by
// millisecond only, which is fine for pagination of a per-owner list.
package ids

import (
	"crypto/rand"
	"encoding/hex"
	"sync"

	"example.com/api-service/internal/platform/clock"
)

// MaxID sorts after every generated id; used as the "no cursor yet" bound.
const MaxID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

// Generator produces UUIDv7 strings. It is safe for concurrent use.
type Generator struct {
	clock  clock.Clock
	mu     sync.Mutex
	lastMs int64
	seq    uint16
}

// NewGenerator returns a Generator reading time from c.
func NewGenerator(c clock.Clock) *Generator { return &Generator{clock: c} }

// New returns a new id.
func (g *Generator) New() string {
	g.mu.Lock()
	defer g.mu.Unlock()

	ms := g.clock.Now().UnixMilli()
	if ms > g.lastMs {
		g.lastMs = ms
		g.seq = randomSeq()
	} else {
		g.seq++
		if g.seq > 0x0fff {
			g.lastMs++
			g.seq = randomSeq()
		}
	}

	var b [16]byte
	ts := uint64(g.lastMs) //nolint:gosec // a unix-millisecond clock is positive
	b[0], b[1], b[2] = byte(ts>>40&0xff), byte(ts>>32&0xff), byte(ts>>24&0xff)
	b[3], b[4], b[5] = byte(ts>>16&0xff), byte(ts>>8&0xff), byte(ts&0xff)
	b[6] = 0x70 | byte(g.seq>>8)
	b[7] = byte(g.seq)      //nolint:gosec // low byte, truncation intended
	_, _ = rand.Read(b[8:]) // crypto/rand.Read does not fail on supported platforms
	b[8] = b[8]&0x3f | 0x80 // RFC 9562 variant

	var out [36]byte
	hex.Encode(out[0:8], b[0:4])
	out[8] = '-'
	hex.Encode(out[9:13], b[4:6])
	out[13] = '-'
	hex.Encode(out[14:18], b[6:8])
	out[18] = '-'
	hex.Encode(out[19:23], b[8:10])
	out[23] = '-'
	hex.Encode(out[24:36], b[10:16])
	return string(out[:])
}

// randomSeq starts a millisecond's counter below 0x800 so there is headroom to
// count up before the counter would overflow.
func randomSeq() uint16 {
	var r [2]byte
	_, _ = rand.Read(r[:])
	return (uint16(r[0])<<8 | uint16(r[1])) & 0x07ff
}

// Valid reports whether s is a canonical lowercase UUID string. Handlers use it
// to turn a malformed path id into a 404 instead of a database error.
func Valid(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
				return false
			}
		}
	}
	return true
}
