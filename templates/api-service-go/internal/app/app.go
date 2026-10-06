// Package app is the composition root: the one place that knows every concrete
// type and wires them together. Everything else depends on small interfaces.
//
// Why a single root with plain constructor injection (no DI framework, no
// globals): the dependency graph is readable top to bottom in one file, a test
// builds the same graph with in-memory repositories (Options is the seam), and
// there is no reflection to debug. Adding a feature is three lines here:
// construct its service, embed its handler in `server`, done. The generated
// interface (internal/api) makes forgetting a route a compile error.
package app

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	apispec "example.com/api-service/api"
	"example.com/api-service/internal/api"
	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/features/items"
	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/config"
	"example.com/api-service/internal/platform/httpx"
	"example.com/api-service/internal/platform/ids"
	"example.com/api-service/internal/platform/ratelimit"
)

// publicRoutes are the ServeMux patterns reachable without a token. A test
// asserts this equals the operations marked `security: []` in the OpenAPI
// document, so the spec and the gate cannot drift apart.
var publicRoutes = map[string]bool{
	"GET /healthz":           true,
	"GET /readyz":            true,
	"GET /openapi.yaml":      true,
	"POST /v1/auth/register": true,
	"POST /v1/auth/login":    true,
}

// localAuthRoutes are the credential endpoints that exist only in local mode.
// In AUTH_MODE=oidc they answer 404 before anything else looks at the request.
var localAuthRoutes = map[string]bool{
	"POST /v1/auth/register": true,
	"POST /v1/auth/login":    true,
	"POST /v1/auth/logout":   true,
}

// PublicRoutes returns a copy of the public route patterns (for tests).
func PublicRoutes() map[string]bool {
	out := make(map[string]bool, len(publicRoutes))
	for k, v := range publicRoutes {
		out[k] = v
	}
	return out
}

// Options are the App's dependencies. Production fills the repositories with
// PostgreSQL adapters (see PostgresOptions); tests fill them with the in-memory
// ones.
type Options struct {
	Config   config.Config
	Logger   *slog.Logger
	Users    auth.UserRepository
	Sessions auth.SessionRepository
	Items    items.Repository
	Hasher   auth.Hasher
	Clock    clock.Clock
	// Verifier checks identity-provider tokens when Config.AuthMode is oidc. Nil
	// means "build the JWKS verifier from Config" (production); tests inject one.
	// It is ignored in local mode.
	Verifier auth.TokenVerifier
	// Ping checks the database for /readyz; nil means "always ready".
	Ping func(context.Context) error
}

// PostgresOptions fills the storage and hashing dependencies of o from a pool.
func PostgresOptions(cfg config.Config, logger *slog.Logger, pool *pgxpool.Pool) Options {
	params := auth.DefaultArgon2Params()
	params.Memory, params.Iterations, params.Parallelism = cfg.Argon2MemoryKiB, cfg.Argon2Iterations, cfg.Argon2Parallelism
	return Options{
		Config:   cfg,
		Logger:   logger,
		Users:    auth.NewPostgresUserRepository(pool),
		Sessions: auth.NewPostgresSessionRepository(pool),
		Items:    items.NewPostgresRepository(pool),
		Hasher:   auth.NewArgon2idHasher(params, 0),
		Ping:     pool.Ping,
	}
}

// Each feature's handler type is called Handler, so embedding them directly
// would collide on the field name; these wrappers give them distinct names.
type (
	itemsAPI struct{ *items.Handler }
	authAPI  struct{ *auth.Handler }
)

// server is the generated strict interface implemented by embedding each
// feature's handler. A method missing from the OpenAPI document does not
// exist here, and a document operation nobody implemented fails to compile.
type server struct {
	itemsAPI
	authAPI
	*ops
}

var _ api.StrictServerInterface = server{}

// App is the assembled service.
type App struct {
	handler  http.Handler
	draining atomic.Bool
}

// New wires the service. Background goroutines (limiter sweeps) stop when ctx ends.
func New(ctx context.Context, o Options) (*App, error) {
	if o.Clock == nil {
		o.Clock = clock.System{}
	}
	a := &App{}
	idgen := ids.NewGenerator(o.Clock)

	verifier, err := tokenVerifier(ctx, o)
	if err != nil {
		return nil, err
	}
	authSvc, err := auth.NewService(ctx, auth.Deps{
		Users: o.Users, Sessions: o.Sessions, Hasher: o.Hasher, Clock: o.Clock,
		IDs: idgen, TTL: o.Config.SessionTTL, Logger: o.Logger, Verifier: verifier,
	})
	if err != nil {
		return nil, err
	}
	itemSvc := items.NewService(o.Items, idgen, o.Clock)

	srv := server{
		itemsAPI{items.NewHandler(itemSvc)},
		authAPI{auth.NewHandler(authSvc)},
		&ops{logger: o.Logger, ping: o.Ping, draining: &a.draining, spec: apispec.YAML},
	}
	strict := api.NewStrictHandlerWithOptions(srv, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  httpx.RequestErrorHandler(o.Logger),
		ResponseErrorHandlerFunc: httpx.ErrorHandler(o.Logger),
	})

	mux := http.NewServeMux()
	api.HandlerWithOptions(strict, api.StdHTTPServerOptions{
		BaseRouter:       mux,
		ErrorHandlerFunc: httpx.ParamErrorHandler,
		// oapi-codegen applies these innermost-first: the last entry runs first, so
		// local-auth rejection (oidc mode) precedes authentication.
		Middlewares: []api.MiddlewareFunc{
			authSvc.Middleware(func(r *http.Request) bool { return publicRoutes[r.Pattern] }, httpx.ErrorHandler(o.Logger)),
			authSvc.RejectLocalAuth(func(r *http.Request) bool { return localAuthRoutes[r.Pattern] }, httpx.ErrorHandler(o.Logger)),
		},
	})
	mux.Handle("/", httpx.NotFoundOrMethodNotAllowed(mux))

	cfg := o.Config
	general := ratelimit.New(cfg.RateLimitRPS, cfg.RateLimitBurst, 10*time.Minute, nil)
	authLimiter := ratelimit.New(cfg.AuthRateLimitRPM/60, cfg.AuthRateLimitBurst, 10*time.Minute, nil)
	go general.Run(ctx, time.Minute)
	go authLimiter.Run(ctx, time.Minute)

	a.handler = httpx.Chain(mux,
		otelhttp.NewMiddleware("http.server", otelhttp.WithFilter(httpx.NotProbe)),
		httpx.RequestID,
		httpx.AccessLog(o.Logger, time.Now),
		httpx.Recover(o.Logger),
		httpx.SecurityHeaders(cfg.Production()),
		httpx.CORS(cfg.CORSAllowedOrigins),
		httpx.RateLimit(general, httpx.NotProbe),
		httpx.RateLimit(authLimiter, httpx.PathPrefix("/v1/auth/login", "/v1/auth/register")),
		httpx.RequireJSON,
		httpx.MaxBody(cfg.MaxBodyBytes),
		httpx.Timeout(cfg.RequestTimeout),
	)
	return a, nil
}

// Handler returns the full HTTP handler. Middleware order, outermost first:
//
//	otelhttp    trace context and span (no-op until telemetry is configured)
//	RequestID   id for logs, problems and the X-Request-Id header
//	AccessLog   one line per request; sees the final status
//	Recover     a panic becomes a logged 500 problem
//	Security    response headers
//	CORS        allow-listed origins; answers preflights
//	RateLimit   general limiter (probes exempt), then the stricter auth limiter
//	RequireJSON 415 for a non-JSON body on a write request
//	MaxBody     declared and streamed size cap
//	Timeout     per-request context deadline
//	mux         generated routes; authentication on every non-public route
func (a *App) Handler() http.Handler { return a.handler }

// Drain marks the service not ready so load balancers stop sending traffic
// before the listener closes. Serve calls it when shutdown begins.
func (a *App) Drain() { a.draining.Store(true) }

// ops implements the operational endpoints of the generated interface.
type ops struct {
	logger   *slog.Logger
	ping     func(context.Context) error
	draining *atomic.Bool
	spec     []byte
}

var (
	errDraining      = apperr.New(apperr.KindUnavailable, "the service is shutting down")
	errNotReadyDB    = apperr.New(apperr.KindUnavailable, "the database is not reachable")
	readinessTimeout = 2 * time.Second
)

// Healthz implements GET /healthz: the process is up. No dependency is
// consulted, so a database outage never gets the container killed.
func (o *ops) Healthz(context.Context, api.HealthzRequestObject) (api.HealthzResponseObject, error) {
	return api.Healthz200JSONResponse{Status: api.Ok}, nil
}

// Readyz implements GET /readyz: the service can take traffic.
func (o *ops) Readyz(ctx context.Context, _ api.ReadyzRequestObject) (api.ReadyzResponseObject, error) {
	if o.draining.Load() {
		return nil, errDraining
	}
	if o.ping != nil {
		pctx, cancel := context.WithTimeout(ctx, readinessTimeout)
		defer cancel()
		if err := o.ping(pctx); err != nil {
			o.logger.WarnContext(ctx, "readiness check failed", slog.String("error", err.Error()))
			return nil, errNotReadyDB
		}
	}
	return api.Readyz200JSONResponse{Status: api.Ok}, nil
}

// GetOpenAPI implements GET /openapi.yaml.
func (o *ops) GetOpenAPI(context.Context, api.GetOpenAPIRequestObject) (api.GetOpenAPIResponseObject, error) {
	return api.GetOpenAPI200ApplicationyamlResponse{Body: bytes.NewReader(o.spec), ContentLength: int64(len(o.spec))}, nil
}

// tokenVerifier returns the identity-provider verifier for oidc mode and nil
// (local mode) otherwise. The JWKS verifier is built here, from validated
// configuration, so a deployment cannot reach oidc mode with a different
// verifier than the one its settings describe.
func tokenVerifier(ctx context.Context, o Options) (auth.TokenVerifier, error) {
	if !o.Config.OIDC() {
		return nil, nil //nolint:nilnil // nil verifier is the documented "local mode"
	}
	if o.Verifier != nil {
		return o.Verifier, nil
	}
	v, err := auth.NewJWKSVerifier(ctx, auth.JWKSConfig{
		Issuer: o.Config.OIDCIssuer, JWKSURI: o.Config.OIDCJWKSURI, Audience: o.Config.OIDCAudience,
		Leeway: o.Config.OIDCClockSkew, Now: o.Clock.Now, Logger: o.Logger,
	})
	if err != nil {
		return nil, fmt.Errorf("app: %w", err)
	}
	return v, nil
}
