// Package version holds the build stamp.
//
// The variables are set at link time (`-ldflags "-X .../version.Version=..."`,
// see the Makefile and Dockerfile), so the same source produces a binary that
// can say exactly which commit it is, with no generated file to forget to
// commit. The defaults mark an unstamped `go run` build.
package version

import "fmt"

// Set by -ldflags at build time.
var (
	Version = "dev"
	Commit  = "unknown"
	Date    = "unknown"
)

// String is the one-line description printed by `server version` and logged at startup.
func String() string {
	return fmt.Sprintf("%s (commit %s, built %s)", Version, Commit, Date)
}
