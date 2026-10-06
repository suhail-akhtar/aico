package version_test

import (
	"strings"
	"testing"

	"example.com/api-service/internal/platform/version"
)

func TestStringHasAllParts(t *testing.T) {
	t.Parallel()
	s := version.String()
	for _, part := range []string{version.Version, version.Commit, version.Date} {
		if !strings.Contains(s, part) {
			t.Errorf("%q missing %q", s, part)
		}
	}
}
