// Package apispec embeds the OpenAPI document so the binary can serve the exact
// contract it was generated from at GET /openapi.yaml. The file lives next to
// this one because go:embed cannot reach outside its own directory; the
// generator config sits beside it for the same reason.
package apispec

import _ "embed"

// YAML is the contents of openapi.yaml.
//
//go:embed openapi.yaml
var YAML []byte
