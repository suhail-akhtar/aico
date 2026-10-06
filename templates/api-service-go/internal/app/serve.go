package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"example.com/api-service/internal/platform/config"
)

// Serve runs the HTTP server on ln until ctx is cancelled, then shuts down
// gracefully: it flips readiness to "draining" first (so a load balancer stops
// routing here), then stops accepting connections and waits, up to
// cfg.ShutdownTimeout, for in-flight requests to finish.
//
// The server timeouts are the defence against slow-client attacks: without
// ReadHeaderTimeout a client can hold a connection open forever by trickling a
// header (Slowloris). WriteTimeout is the request deadline plus slack so a
// handler that ran to its deadline can still write its error response.
func Serve(ctx context.Context, a *App, ln net.Listener, cfg config.Config, logger *slog.Logger) error {
	srv := &http.Server{
		Handler:           a.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      cfg.RequestTimeout + 5*time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    64 << 10,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	logger.InfoContext(ctx, "server listening", slog.String("addr", ln.Addr().String()))

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	logger.InfoContext(ctx, "shutting down", slog.String("timeout", cfg.ShutdownTimeout.String()))
	a.Drain()
	// A fresh context: ctx is already cancelled, and shutdown needs its own deadline.
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		_ = srv.Close() // deadline exceeded: drop the stragglers
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	logger.InfoContext(ctx, "server stopped")
	return nil
}
