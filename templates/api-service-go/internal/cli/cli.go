// Package cli is the command dispatcher behind cmd/server: serve (default),
// migrate, seed, healthcheck, version.
//
// Why the logic is here and cmd/server/main.go is five lines: a main package
// cannot be imported by tests, and the startup path (config, telemetry,
// database, migrations, listen, graceful shutdown) is exactly the code that
// breaks in production. Here it is a function of its inputs (args, environment,
// output writers), so tests drive it directly and assert exit codes.
//
// Exit codes: 0 success, 1 runtime failure, 2 usage or configuration error.
// `healthcheck` exists because the runtime image is distroless (no shell, no
// curl, no wget): the container HEALTHCHECK runs the binary itself.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"example.com/api-service/internal/app"
	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/features/items"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/config"
	"example.com/api-service/internal/platform/database"
	"example.com/api-service/internal/platform/ids"
	"example.com/api-service/internal/platform/logging"
	"example.com/api-service/internal/platform/telemetry"
	"example.com/api-service/internal/platform/version"
)

const usage = `usage: server [command]

commands:
  serve        run the API (default)
  migrate      apply pending database migrations and exit
  seed         create a demo account and sample items (never in production; a no-op when AUTH_MODE=oidc)
  healthcheck  GET /healthz on this container and exit 0/1 (used by HEALTHCHECK)
  version      print the build stamp
`

// Run executes a command and returns the process exit code.
func Run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "version", "--version":
		_, _ = fmt.Fprintln(stdout, version.String())
		return 0
	case "healthcheck":
		return report(stderr, Healthcheck(ctx, getenv, http.DefaultClient))
	case "help", "-h", "--help":
		_, _ = fmt.Fprint(stdout, usage)
		return 0
	case "serve", "migrate", "seed":
	default:
		_, _ = fmt.Fprintf(stderr, "unknown command %q\n\n%s", cmd, usage)
		return 2
	}

	cfg, err := config.Load(getenv)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 2
	}
	logger := logging.New(stdout, cfg.LogLevel)

	var runErr error
	switch cmd {
	case "serve":
		runErr = serve(ctx, cfg, logger)
	case "migrate":
		runErr = migrate(ctx, cfg, logger)
	case "seed":
		runErr = seed(ctx, cfg, getenv("SEED_PASSWORD"), logger)
	}
	if runErr != nil {
		logger.ErrorContext(ctx, "command failed", slog.String("command", cmd), slog.String("error", runErr.Error()))
		return 1
	}
	return 0
}

func report(stderr io.Writer, err error) int {
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func serve(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	logger.InfoContext(ctx, "starting", slog.String("version", version.String()), slog.Any("config", cfg))
	if cfg.Production() && strings.Contains(cfg.DatabaseURL, "sslmode=disable") {
		logger.WarnContext(ctx, "DATABASE_URL has sslmode=disable in production; use sslmode=verify-full unless the database is on a private network you trust")
	}

	shutdownTelemetry, err := telemetry.Setup(ctx, cfg.OTelEnabled, cfg.OTelServiceName, version.Version)
	if err != nil {
		return err
	}
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := shutdownTelemetry(flushCtx); err != nil {
			logger.WarnContext(flushCtx, "telemetry flush failed", slog.String("error", err.Error()))
		}
	}()

	pool, err := database.Open(ctx, cfg.DatabaseURL, database.Options{MaxConns: cfg.DBMaxConns})
	if err != nil {
		return err
	}
	defer pool.Close()

	if cfg.MigrateOnStart {
		if err := database.Migrate(ctx, pool, 0); err != nil {
			return err
		}
	} else if n, err := database.Pending(ctx, pool); err != nil {
		return err
	} else if n > 0 {
		return fmt.Errorf("%d database migrations are pending and MIGRATE_ON_START is false; run `server migrate` first", n)
	}

	a, err := app.New(ctx, app.PostgresOptions(cfg, logger, pool))
	if err != nil {
		return err
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.Addr())
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.Addr(), err)
	}
	return app.Serve(ctx, a, ln, cfg, logger)
}

func migrate(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	pool, err := database.Open(ctx, cfg.DatabaseURL, database.Options{MaxConns: 2})
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := database.Migrate(ctx, pool, 0); err != nil {
		return err
	}
	logger.InfoContext(ctx, "migrations applied")
	return nil
}

// seed creates a demo account with a few items for local development. It reads
// the password from SEED_PASSWORD (never a default: a well-known password in a
// shared database is a backdoor) and refuses to run in production. In oidc mode
// it does nothing and succeeds, so a compose file that always runs it still works.
func seed(ctx context.Context, cfg config.Config, password string, logger *slog.Logger) error {
	if cfg.OIDC() {
		// Accounts belong to the identity provider; a local demo user could never sign in.
		logger.InfoContext(ctx, "seed skipped: AUTH_MODE=oidc creates accounts on first sign-in, not locally")
		return nil
	}
	if cfg.Production() {
		return errors.New("refusing to seed in production (APP_ENV=production)")
	}
	if utf8.RuneCountInString(password) < auth.MinPasswordLen {
		return fmt.Errorf("SEED_PASSWORD must be set to at least %d characters", auth.MinPasswordLen)
	}
	pool, err := database.Open(ctx, cfg.DatabaseURL, database.Options{MaxConns: 2})
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := database.Migrate(ctx, pool, 0); err != nil {
		return err
	}

	opts := app.PostgresOptions(cfg, logger, pool)
	idgen := ids.NewGenerator(clock.System{})
	authSvc, err := auth.NewService(ctx, auth.Deps{
		Users: opts.Users, Sessions: opts.Sessions, Hasher: opts.Hasher,
		Clock: clock.System{}, IDs: idgen, TTL: cfg.SessionTTL, Logger: logger,
	})
	if err != nil {
		return err
	}
	user, err := authSvc.Register(ctx, cfg.SeedEmail, password)
	if errors.Is(err, auth.ErrEmailTaken) {
		logger.InfoContext(ctx, "seed account already exists; nothing to do", slog.String("email", cfg.SeedEmail))
		return nil
	}
	if err != nil {
		return err
	}
	itemSvc := items.NewService(opts.Items, idgen, clock.System{})
	for i, name := range []string{"Sample notebook", "Sample pen", "Sample stapler"} {
		if _, err := itemSvc.Create(ctx, user.ID, items.Input{Name: name, Description: "Created by `server seed`.", Quantity: i + 1}); err != nil {
			return err
		}
	}
	logger.InfoContext(ctx, "seeded demo account", slog.String("email", user.Email), slog.Int("items", 3))
	return nil
}

// Healthcheck probes this process's /healthz on 127.0.0.1:$PORT. Only PORT is
// read, not the full configuration, so the probe works even if the rest of the
// environment is not visible to the HEALTHCHECK process.
func Healthcheck(ctx context.Context, getenv func(string) string, client *http.Client) error {
	port := getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("healthcheck: invalid PORT %q", port)
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/healthz", http.NoBody)
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: /healthz answered %d", resp.StatusCode)
	}
	return nil
}
