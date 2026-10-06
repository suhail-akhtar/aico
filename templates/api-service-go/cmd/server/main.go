// Command server is the API's entry point. All logic lives in internal/cli so
// it can be tested; this file only connects the process to it: signals become
// context cancellation (SIGTERM from the orchestrator, Ctrl-C locally), and the
// returned code becomes the exit status.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"example.com/api-service/internal/cli"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cli.Run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}
