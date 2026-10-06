// Package db embeds the SQL migrations into the binary.
//
// Why embedded: the container image is `FROM scratch`-like (distroless static)
// and holds one file; the migrations travel inside it, so a deployed binary can
// always migrate the database it is about to use and can never meet a missing
// or mismatched migrations directory. The queries in db/queries are NOT
// embedded: sqlc compiles them to Go at `make gen` time.
package db

import (
	"embed"
	"io/fs"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Migrations is the migrations directory as a filesystem rooted at the .sql files.
func Migrations() fs.FS {
	sub, err := fs.Sub(migrations, "migrations")
	if err != nil {
		panic(err) // only possible if the embed pattern above is wrong; caught by any test
	}
	return sub
}
