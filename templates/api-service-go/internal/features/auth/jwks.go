package auth

// Verification of access tokens issued by an external OpenID Connect provider
// (AUTH_MODE=oidc).
//
// Why a library and not hand-rolled crypto: JOSE has a long record of verifier
// bugs (alg=none, HS256-with-the-public-key, kid injection). golang-jwt/jwt v5 is
// the maintained, MIT-licensed parser; MicahParks/keyfunc + jwkset (Apache-2.0)
// supply the JWKS cache. coreos/go-oidc was the first candidate and was
// rejected: its RemoteKeySet refetches on every unknown `kid` with no rate limit
// (a flood of forged kids would hammer the IdP), its verifier models ID tokens
// rather than access tokens, and it applies a fixed 5-minute not-before leeway
// where the contract allows 60 seconds.
//
// What this file enforces, all in-process and never on the proxy's say-so:
// RS256 only (the parser rejects every other `alg`, including none and HS*, before
// a key is looked up); `iss` equal to the configured issuer byte for byte; `aud`
// containing the configured audience; `exp` required; `nbf`/`iat` honoured; a
// leeway of at most 60 s; a `kid` that selects a signature-use RSA key of at least
// 2048 bits; and a `sub` that is a UUID. The key set is cached, refreshed hourly,
// and refetched for an unknown `kid` at most once per UnknownKIDInterval, with
// every fetch bounded by a timeout.
//
// It does not check `azp`, `scope` or roles: which client may call which route is
// an authorisation policy for the feature that needs it, not a property of being
// authenticated. It does not call the userinfo or introspection endpoints: both
// would put the IdP in the request path.

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/MicahParks/jwkset"
	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/time/rate"

	"example.com/api-service/internal/platform/ids"
)

const (
	oidcAlg    = "RS256"
	maxJWTLen  = 8 << 10 // Keycloak tokens with many roles reach a few KiB; 8 KiB is generous and bounded
	minRSABits = 2048
	maxLeeway  = time.Minute

	// jwksTimeout bounds every request to the JWKS endpoint, including the
	// refetch an unknown kid triggers inside a user request.
	jwksTimeout = 5 * time.Second
	// jwksRefreshInterval re-reads the key set even when nothing asked for it, so a
	// revoked key disappears within the hour.
	jwksRefreshInterval = time.Hour
	// DefaultUnknownKIDInterval is how often at most a token with an unknown kid
	// may trigger a refetch. Rotation is rare; a flood of forged kids must not
	// become a flood of requests to the identity provider.
	DefaultUnknownKIDInterval = 15 * time.Second
)

// Claims are the verified facts about a caller that the service uses.
type Claims struct {
	// Subject is the token's `sub`, a lower-case canonical UUID.
	Subject string
	// Email is the lower-cased `email` claim, or "" when the token has none.
	Email string
}

// TokenVerifier turns a bearer token into verified Claims, or an error. The
// service maps every error to a 401: callers never learn why a token was refused.
type TokenVerifier interface {
	Verify(ctx context.Context, token string) (Claims, error)
}

// JWKSConfig configures a JWKSVerifier.
type JWKSConfig struct {
	Issuer   string // exact expected `iss`
	JWKSURI  string // where the signing keys are fetched
	Audience string // required `aud` value
	// Leeway tolerates clock skew on exp, nbf and iat; 0..60 s.
	Leeway time.Duration
	// Now is the clock; nil means time.Now. Tests inject a fake.
	Now func() time.Time
	// HTTPClient fetches the key set; nil means a client with a 5 s timeout.
	HTTPClient *http.Client
	// UnknownKIDInterval overrides DefaultUnknownKIDInterval; 0 means the default.
	UnknownKIDInterval time.Duration
	Logger             *slog.Logger
}

// accessClaims is the subset of the token payload the service reads.
type accessClaims struct {
	jwt.RegisteredClaims
	Email string `json:"email"`
}

// JWKSVerifier verifies RS256 JWTs against a remote JWKS.
type JWKSVerifier struct {
	parser *jwt.Parser
	keys   keyfunc.Keyfunc
}

var _ TokenVerifier = (*JWKSVerifier)(nil)

// NewJWKSVerifier builds a verifier and starts the background key refresh, which
// stops when ctx ends. It fetches the key set once before returning but does not
// fail when the identity provider is unreachable: an API that exited because the
// IdP was still starting would turn a slow boot order into an outage. Until a
// fetch succeeds every token is refused (401), and the first token carrying a
// kid triggers a fetch.
func NewJWKSVerifier(ctx context.Context, c JWKSConfig) (*JWKSVerifier, error) {
	switch {
	case c.Issuer == "" || c.JWKSURI == "" || c.Audience == "":
		return nil, errors.New("auth: oidc verifier needs an issuer, a JWKS URI and an audience")
	case c.Leeway < 0 || c.Leeway > maxLeeway:
		return nil, fmt.Errorf("auth: oidc clock skew must be between 0 and %s", maxLeeway)
	}
	now, logger, client := c.Now, c.Logger, c.HTTPClient
	if now == nil {
		now = time.Now
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if client == nil {
		client = &http.Client{Timeout: jwksTimeout}
	}
	interval := c.UnknownKIDInterval
	if interval <= 0 {
		interval = DefaultUnknownKIDInterval
	}

	store, err := jwkset.NewStorageFromHTTP(c.JWKSURI, jwkset.HTTPClientStorageOptions{
		Client:                    client,
		Ctx:                       ctx,
		HTTPTimeout:               jwksTimeout,
		NoErrorReturnFirstHTTPReq: true,
		RefreshInterval:           jwksRefreshInterval,
		RefreshErrorHandler: func(ctx context.Context, err error) {
			logger.WarnContext(ctx, "could not refresh the signing keys of the identity provider", slog.String("error", err.Error()))
		},
	})
	if err != nil {
		return nil, fmt.Errorf("auth: create JWKS client: %w", err)
	}
	remote, err := jwkset.NewHTTPClient(jwkset.HTTPClientOptions{
		HTTPURLs:          map[string]jwkset.Storage{c.JWKSURI: store},
		RateLimitWaitMax:  jwksTimeout, // a refused refetch fails fast instead of queueing requests
		RefreshUnknownKID: rate.NewLimiter(rate.Every(interval), 1),
	})
	if err != nil {
		return nil, fmt.Errorf("auth: create JWKS client: %w", err)
	}
	keys, err := keyfunc.New(keyfunc.Options{
		Ctx:     ctx,
		Storage: remote,
		// Keycloak also publishes encryption keys (use=enc); they must never verify a signature.
		UseWhitelist: []jwkset.USE{jwkset.UseSig, ""},
	})
	if err != nil {
		return nil, fmt.Errorf("auth: create key function: %w", err)
	}
	return &JWKSVerifier{
		keys: keys,
		parser: jwt.NewParser(
			jwt.WithValidMethods([]string{oidcAlg}),
			jwt.WithIssuer(c.Issuer),
			jwt.WithAudience(c.Audience),
			jwt.WithExpirationRequired(),
			jwt.WithIssuedAt(),
			jwt.WithLeeway(c.Leeway),
			jwt.WithTimeFunc(now),
			jwt.WithStrictDecoding(),
		),
	}, nil
}

// Verify checks token and returns its claims. The returned error describes why
// for the logs; it never contains the token.
func (v *JWKSVerifier) Verify(ctx context.Context, token string) (Claims, error) {
	if token == "" || len(token) > maxJWTLen {
		return Claims{}, errors.New("token is empty or too long")
	}
	var cl accessClaims
	if _, err := v.parser.ParseWithClaims(token, &cl, v.keyFunc(ctx)); err != nil {
		return Claims{}, fmt.Errorf("verify token: %w", err)
	}
	sub := strings.ToLower(cl.Subject)
	if !ids.Valid(sub) {
		return Claims{}, errors.New("verify token: sub is missing or not a UUID")
	}
	return Claims{Subject: sub, Email: NormaliseEmail(cl.Email)}, nil
}

// keyFunc selects the verification key. Two rules beyond keyfunc's own: a token
// must name its key (without a kid keyfunc would try every key in the set,
// including ones this service never meant to trust), and the key must be an RSA
// key of a sound size.
func (v *JWKSVerifier) keyFunc(ctx context.Context) jwt.Keyfunc {
	inner := v.keys.KeyfuncCtx(ctx)
	return func(t *jwt.Token) (any, error) {
		if kid, _ := t.Header["kid"].(string); kid == "" {
			return nil, errors.New("token header has no kid")
		}
		key, err := inner(t)
		if err != nil {
			return nil, err
		}
		pub, ok := key.(*rsa.PublicKey)
		if !ok || pub.N.BitLen() < minRSABits {
			return nil, fmt.Errorf("signing key is not an RSA key of at least %d bits", minRSABits)
		}
		return pub, nil
	}
}
