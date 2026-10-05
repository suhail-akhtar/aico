/**
 * Generates the go-request-path task's repository: a Go HTTP service
 * (~120 files) — a small router, middleware, ten domains each with routes,
 * handlers, a service and a Postgres store — as the fixture, or with the
 * reference answer (TRACE.md plus `validateOrderInput` in the service layer).
 *
 * Why it is shaped like this: "how does POST /api/orders reach the database,
 * and where does validation belong?" is the path question a code graph claims
 * to answer in one query. The obvious names mislead: the service that serves
 * /api/orders lives in internal/service/orders but is `package ordering`, while
 * a legacy service in internal/service/orderlegacy is `package orders` with a
 * `Create` method and its own store (it serves /admin/orders and a backfill
 * tool). The handler talks to the service through an interface wired in
 * internal/app, and a queue consumer calls the same service — which is why the
 * check belongs in the service, not the HTTP handler.
 *
 * Deterministic: everything is templated from fixed lists; no randomness.
 */
import { GITIGNORE } from '../../lib/generated.mjs';

const MOD = 'github.com/acme/shopd';
const DOMAINS = ['customers', 'products', 'inventory', 'shipments', 'payments', 'invoices', 'carts', 'reviews', 'coupons', 'refunds', 'wishlists', 'subscriptions'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const singular = (d) => d.replace(/ies$/, 'y').replace(/s$/, '');

function domainFiles(d) {
  const T = cap(singular(d));
  const pkg = singular(d).replace(/[^a-z]/g, '');
  return {
    [`internal/service/${d}/service.go`]: `package ${pkg}

import (
	"context"
	"errors"
)

// ErrNotFound is returned when a ${singular(d)} does not exist.
var ErrNotFound = errors.New("${singular(d)} not found")

// Store persists ${d}.
type Store interface {
	Insert(ctx context.Context, v *${T}) error
	ByID(ctx context.Context, id string) (${T}, error)
}

// Service is the ${d} use-case layer.
type Service struct {
	store Store
}

// NewService builds the ${d} service.
func NewService(store Store) *Service {
	return &Service{store: store}
}

// Create${T} stores a new ${singular(d)}.
func (s *Service) Create${T}(ctx context.Context, in Create${T}Input) (${T}, error) {
	v := ${T}{ID: newID("${pkg.slice(0, 3)}"), Name: in.Name}
	if err := s.store.Insert(ctx, &v); err != nil {
		return ${T}{}, err
	}
	return v, nil
}

// Get${T} loads one ${singular(d)}.
func (s *Service) Get${T}(ctx context.Context, id string) (${T}, error) {
	return s.store.ByID(ctx, id)
}
`,
    [`internal/service/${d}/types.go`]: `package ${pkg}

import "github.com/acme/shopd/pkg/ids"

// ${T} is the ${singular(d)} entity.
type ${T} struct {
	ID   string \`json:"id"\`
	Name string \`json:"name"\`
}

// Create${T}Input is what a client sends to create a ${singular(d)}.
type Create${T}Input struct {
	Name string \`json:"name"\`
}

func newID(prefix string) string { return ids.New(prefix) }
`,
    [`internal/service/${d}/service_test.go`]: `package ${pkg}

import (
	"context"
	"testing"
)

type memStore struct{ rows map[string]${T} }

func (m *memStore) Insert(_ context.Context, v *${T}) error { m.rows[v.ID] = *v; return nil }
func (m *memStore) ByID(_ context.Context, id string) (${T}, error) {
	v, ok := m.rows[id]
	if !ok {
		return ${T}{}, ErrNotFound
	}
	return v, nil
}

func TestCreate${T}(t *testing.T) {
	svc := NewService(&memStore{rows: map[string]${T}{}})
	v, err := svc.Create${T}(context.Background(), Create${T}Input{Name: "x"})
	if err != nil || v.Name != "x" {
		t.Fatalf("create: %v %+v", err, v)
	}
}
`,
    [`internal/store/pg/${singular(d)}_store.go`]: `package pg

import (
	"context"

	"${MOD}/internal/platform/db"
	"${MOD}/internal/service/${d}"
)

// ${T}Store is the Postgres store for ${d}.
type ${T}Store struct{ db db.DB }

// New${T}Store builds the store.
func New${T}Store(conn db.DB) *${T}Store { return &${T}Store{db: conn} }

// Insert writes one row.
func (s *${T}Store) Insert(ctx context.Context, v *${pkg}.${T}) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO ${d} (id, name) VALUES ($1, $2)", v.ID, v.Name)
	return err
}

// ByID reads one row.
func (s *${T}Store) ByID(ctx context.Context, id string) (${pkg}.${T}, error) {
	var v ${pkg}.${T}
	err := s.db.QueryRowContext(ctx, "SELECT id, name FROM ${d} WHERE id = $1", id).Scan(&v.ID, &v.Name)
	return v, err
}
`,
    [`internal/httpapi/${d}_routes.go`]: `package httpapi

import "${MOD}/internal/platform/mux"

func ${singular(d)}Routes(svc ${T}Service) *mux.Router {
	r := mux.New()
	r.Post("/", handleCreate${T}(svc))
	r.Get("/{id}", handleGet${T}(svc))
	return r
}
`,
    [`internal/httpapi/handlers_${d}.go`]: `package httpapi

import (
	"encoding/json"
	"net/http"

	"${MOD}/internal/platform/mux"
	"${MOD}/internal/service/${d}"
)

func handleCreate${T}(svc ${T}Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in ${pkg}.Create${T}Input
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "malformed body")
			return
		}
		v, err := svc.Create${T}(r.Context(), in)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not create ${singular(d)}")
			return
		}
		writeJSON(w, http.StatusCreated, v)
	}
}

func handleGet${T}(svc ${T}Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := svc.Get${T}(r.Context(), mux.Param(r, "id"))
		if err != nil {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}
`,
  };
}

/** The repository as a map of relative path → contents, and the grader's metadata. */
export function generate(variant = 'fixture') {
  const ref = variant === 'reference';
  const files = new Map();
  const set = (rel, text) => files.set(rel, text);

  set('.gitignore', GITIGNORE);
  set('go.mod', `module ${MOD}\n\ngo 1.22\n`);
  set('README.md', '# shopd\n\nThe shop\'s HTTP API. `go run ./cmd/shopd`, `go test ./...`.\n\nLayout: `internal/httpapi` (routes and handlers), `internal/service/*` (use cases), `internal/store/pg` (Postgres), `internal/consumer` (queue consumers), `internal/app` (wiring).\n');
  set('cmd/shopd/main.go', `package main

import (
	"log"

	"${MOD}/internal/app"
	"${MOD}/internal/platform/config"
)

func main() {
	cfg := config.FromEnv()
	if err := app.New(cfg).Run(); err != nil {
		log.Fatal(err)
	}
}
`);
  set('internal/platform/config/config.go', `package config

import "os"

// Config is read once at startup.
type Config struct {
	Addr        string
	DatabaseURL string
	QueueURL    string
}

// FromEnv reads the configuration from the environment.
func FromEnv() Config {
	return Config{Addr: getenv("ADDR", ":8080"), DatabaseURL: os.Getenv("DATABASE_URL"), QueueURL: os.Getenv("QUEUE_URL")}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
`);
  set('internal/platform/db/db.go', `package db

import (
	"context"
	"database/sql"
)

// DB is the subset of *sql.DB the stores use.
type DB interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Open connects to Postgres.
func Open(url string) (*sql.DB, error) { return sql.Open("pgx", url) }
`);
  set('internal/platform/mux/mux.go', `package mux

import (
	"context"
	"net/http"
	"strings"
)

type paramsKey struct{}

// Router is a minimal method+prefix router with sub-router mounting.
type Router struct {
	routes []route
	mounts []mount
}

type route struct {
	method, pattern string
	h               http.Handler
}

type mount struct {
	prefix string
	h      http.Handler
}

// New returns an empty router.
func New() *Router { return &Router{} }

// Post registers a POST handler.
func (r *Router) Post(pattern string, h http.HandlerFunc) { r.routes = append(r.routes, route{"POST", pattern, h}) }

// Get registers a GET handler.
func (r *Router) Get(pattern string, h http.HandlerFunc) { r.routes = append(r.routes, route{"GET", pattern, h}) }

// Mount hands every request under prefix to h, with the prefix stripped.
func (r *Router) Mount(prefix string, h http.Handler) { r.mounts = append(r.mounts, mount{prefix, h}) }

// Route groups registrations under a prefix.
func (r *Router) Route(prefix string, fn func(sub *Router)) {
	sub := New()
	fn(sub)
	r.Mount(prefix, sub)
}

// Param reads a {name} path parameter.
func Param(req *http.Request, name string) string {
	p, _ := req.Context().Value(paramsKey{}).(map[string]string)
	return p[name]
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	for _, m := range r.mounts {
		if strings.HasPrefix(req.URL.Path, m.prefix) {
			req2 := req.Clone(req.Context())
			req2.URL.Path = "/" + strings.TrimPrefix(strings.TrimPrefix(req.URL.Path, m.prefix), "/")
			m.h.ServeHTTP(w, req2)
			return
		}
	}
	for _, rt := range r.routes {
		if rt.method != req.Method {
			continue
		}
		if params, ok := match(rt.pattern, req.URL.Path); ok {
			rt.h.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), paramsKey{}, params)))
			return
		}
	}
	http.NotFound(w, req)
}

func match(pattern, path string) (map[string]string, bool) {
	ps, xs := strings.Split(strings.Trim(pattern, "/"), "/"), strings.Split(strings.Trim(path, "/"), "/")
	if len(ps) != len(xs) {
		return nil, false
	}
	params := map[string]string{}
	for i := range ps {
		if strings.HasPrefix(ps[i], "{") {
			params[strings.Trim(ps[i], "{}")] = xs[i]
		} else if ps[i] != xs[i] {
			return nil, false
		}
	}
	return params, true
}
`);
  for (const m of ['auth', 'logging', 'requestid', 'recoverer', 'cors']) {
    set(`internal/middleware/${m}.go`, `package middleware

import "net/http"

// ${cap(m)} wraps a handler with ${m} behaviour.
func ${cap(m)}(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Mw-${cap(m)}", "1")
		next.ServeHTTP(w, r)
	})
}
`);
  }
  set('pkg/ids/ids.go', `package ids

import (
	"fmt"
	"sync/atomic"
)

var seq atomic.Int64

// New returns a process-unique id with a prefix, e.g. "ord_42".
func New(prefix string) string { return fmt.Sprintf("%s_%d", prefix, seq.Add(1)) }
`);
  set('pkg/money/money.go', `package money

// Cents multiplies a unit price by a quantity.
func Cents(unit int64, qty int) int64 { return unit * int64(qty) }
`);
  set('internal/events/publisher.go', `package events

import "context"

// Publisher sends domain events to the bus.
type Publisher interface {
	Publish(ctx context.Context, topic string, payload any) error
}

// Nop drops events (tests, local runs).
type Nop struct{}

// Publish does nothing.
func (Nop) Publish(context.Context, string, any) error { return nil }
`);

  // Orders: the path under study.
  set('internal/service/orders/types.go', `package ordering

import "time"

// CreateOrderInput is the body of POST /api/orders and of an orders.create queue message.
type CreateOrderInput struct {
	CustomerID string \`json:"customer_id"\`
	SKU        string \`json:"sku"\`
	Quantity   int    \`json:"quantity"\`
	UnitCents  int64  \`json:"unit_cents"\`
}

// Order is a placed order.
type Order struct {
	ID         string    \`json:"id"\`
	CustomerID string    \`json:"customer_id"\`
	SKU        string    \`json:"sku"\`
	Quantity   int       \`json:"quantity"\`
	TotalCents int64     \`json:"total_cents"\`
	PlacedAt   time.Time \`json:"placed_at"\`
}
`);
  set('internal/service/orders/errors.go', `package ordering

import "errors"

// ErrInvalidOrder is returned for an order that must not be stored; the HTTP layer maps it to 400.
var ErrInvalidOrder = errors.New("invalid order")

// ErrNotFound is returned when an order does not exist.
var ErrNotFound = errors.New("order not found")
`);
  set('internal/service/orders/ports.go', `package ordering

import "context"

// Store persists orders.
type Store interface {
	Insert(ctx context.Context, o *Order) error
	ByID(ctx context.Context, id string) (Order, error)
}
`);
  set('internal/service/orders/service.go', `package ordering

import (
	"context"
	"time"

	"${MOD}/internal/events"
	"${MOD}/pkg/ids"
	"${MOD}/pkg/money"
)

// Service places and reads orders. It is called by the HTTP API and by the queue consumer.
type Service struct {
	store  Store
	events events.Publisher
	now    func() time.Time
}

// NewService builds the orders service.
func NewService(store Store, pub events.Publisher) *Service {
	return &Service{store: store, events: pub, now: time.Now}
}

// PlaceOrder prices and stores a new order, then announces it.
func (s *Service) PlaceOrder(ctx context.Context, in CreateOrderInput) (Order, error) {
${ref ? '	if err := validateOrderInput(in); err != nil {\n		return Order{}, err\n	}\n' : ''}	o := Order{
		ID:         ids.New("ord"),
		CustomerID: in.CustomerID,
		SKU:        in.SKU,
		Quantity:   in.Quantity,
		TotalCents: money.Cents(in.UnitCents, in.Quantity),
		PlacedAt:   s.now(),
	}
	if err := s.store.Insert(ctx, &o); err != nil {
		return Order{}, err
	}
	_ = s.events.Publish(ctx, "orders.placed", o)
	return o, nil
}

// GetOrder loads one order.
func (s *Service) GetOrder(ctx context.Context, id string) (Order, error) {
	return s.store.ByID(ctx, id)
}
`);
  if (ref) {
    set('internal/service/orders/validate.go', `package ordering

import (
	"fmt"
	"regexp"
)

var skuPattern = regexp.MustCompile(\`^[A-Z]{3}-[0-9]{4}$\`)

// validateOrderInput rejects an order before anything is stored. It lives in the
// service so the HTTP API and the queue consumer get the same rule.
func validateOrderInput(in CreateOrderInput) error {
	if in.Quantity < 1 || in.Quantity > 100 {
		return fmt.Errorf("%w: quantity %d is outside 1..100", ErrInvalidOrder, in.Quantity)
	}
	if !skuPattern.MatchString(in.SKU) {
		return fmt.Errorf("%w: sku %q does not match AAA-0000", ErrInvalidOrder, in.SKU)
	}
	return nil
}
`);
    set('TRACE.md', `# POST /api/orders → database

1. internal/httpapi/router.go: NewRouter
2. internal/httpapi/orders_routes.go: orderRoutes
3. internal/httpapi/handlers_orders.go: handleCreateOrder
4. internal/service/orders/service.go: PlaceOrder
5. internal/store/pg/order_store.go: Insert

## Notes

The service is wired in internal/app/app.go (ordering.NewService with pg.NewOrderStore). The queue consumer
(internal/consumer/orders_consumer.go) also calls PlaceOrder, so validation lives in the service.
`);
  }
  set('internal/service/orders/service_test.go', `package ordering

import (
	"context"
	"testing"

	"${MOD}/internal/events"
)

type memStore struct{ rows map[string]Order }

func (m *memStore) Insert(_ context.Context, o *Order) error { m.rows[o.ID] = *o; return nil }
func (m *memStore) ByID(_ context.Context, id string) (Order, error) {
	o, ok := m.rows[id]
	if !ok {
		return Order{}, ErrNotFound
	}
	return o, nil
}

func TestPlaceOrderPricesAndStores(t *testing.T) {
	store := &memStore{rows: map[string]Order{}}
	svc := NewService(store, events.Nop{})
	o, err := svc.PlaceOrder(context.Background(), CreateOrderInput{CustomerID: "c1", SKU: "ABC-1234", Quantity: 3, UnitCents: 250})
	if err != nil {
		t.Fatal(err)
	}
	if o.TotalCents != 750 || len(store.rows) != 1 {
		t.Fatalf("got %+v, %d rows", o, len(store.rows))
	}
}
`);
  set('internal/store/pg/queries.go', `package pg

const insertOrderSQL = \`INSERT INTO orders (id, customer_id, sku, quantity, total_cents, placed_at) VALUES ($1, $2, $3, $4, $5, $6)\`

const selectOrderSQL = \`SELECT id, customer_id, sku, quantity, total_cents, placed_at FROM orders WHERE id = $1\`
`);
  set('internal/store/pg/order_store.go', `package pg

import (
	"context"

	"${MOD}/internal/platform/db"
	"${MOD}/internal/service/orders"
)

// OrderStore is the Postgres store behind the orders service.
type OrderStore struct{ db db.DB }

// NewOrderStore builds the store.
func NewOrderStore(conn db.DB) *OrderStore { return &OrderStore{db: conn} }

// Insert writes a placed order.
func (s *OrderStore) Insert(ctx context.Context, o *ordering.Order) error {
	_, err := s.db.ExecContext(ctx, insertOrderSQL, o.ID, o.CustomerID, o.SKU, o.Quantity, o.TotalCents, o.PlacedAt)
	return err
}

// ByID reads one order.
func (s *OrderStore) ByID(ctx context.Context, id string) (ordering.Order, error) {
	var o ordering.Order
	err := s.db.QueryRowContext(ctx, selectOrderSQL, id).Scan(&o.ID, &o.CustomerID, &o.SKU, &o.Quantity, &o.TotalCents, &o.PlacedAt)
	return o, err
}
`);
  // Legacy decoy: package `orders`, a `Create` method, its own store.
  set('internal/service/orderlegacy/service.go', `// Package orders is the pre-2025 order model, kept for /admin/orders imports and the backfill tool.
package orders

import (
	"context"
	"errors"
)

// ErrInvalid is the legacy validation error.
var ErrInvalid = errors.New("invalid legacy order")

// Input is a legacy order row.
type Input struct {
	Ref      string
	SKU      string
	Quantity int
}

// Writer persists legacy orders.
type Writer interface {
	WriteLegacy(ctx context.Context, in Input) error
}

// Service imports legacy orders.
type Service struct{ w Writer }

// NewService builds the legacy service.
func NewService(w Writer) *Service { return &Service{w: w} }

// Create stores a legacy order as-is (imports are trusted).
func (s *Service) Create(ctx context.Context, in Input) error {
	if in.Ref == "" {
		return ErrInvalid
	}
	return s.w.WriteLegacy(ctx, in)
}
`);
  set('internal/store/pg/legacy_order_store.go', `package pg

import (
	"context"

	"${MOD}/internal/platform/db"
	orders "${MOD}/internal/service/orderlegacy"
)

// LegacyOrderStore writes imported orders into legacy_orders.
type LegacyOrderStore struct{ db db.DB }

// NewLegacyOrderStore builds the store.
func NewLegacyOrderStore(conn db.DB) *LegacyOrderStore { return &LegacyOrderStore{db: conn} }

// WriteLegacy inserts one imported row.
func (s *LegacyOrderStore) WriteLegacy(ctx context.Context, in orders.Input) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO legacy_orders (ref, sku, quantity) VALUES ($1, $2, $3)", in.Ref, in.SKU, in.Quantity)
	return err
}
`);
  set('internal/httpapi/admin_orders.go', `package httpapi

import (
	"encoding/json"
	"net/http"

	"${MOD}/internal/platform/mux"
	orders "${MOD}/internal/service/orderlegacy"
)

func adminOrderRoutes(svc *orders.Service) *mux.Router {
	r := mux.New()
	r.Post("/", handleAdminImportOrder(svc))
	return r
}

// handleAdminImportOrder serves POST /admin/orders (bulk import of legacy rows).
func handleAdminImportOrder(svc *orders.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in orders.Input
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "malformed body")
			return
		}
		if err := svc.Create(r.Context(), in); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}
}
`);
  set('internal/tools/backfill/main.go', `package main

import (
	"context"
	"log"
	"os"

	"${MOD}/internal/platform/db"
	orders "${MOD}/internal/service/orderlegacy"
	"${MOD}/internal/store/pg"
)

func main() {
	conn, err := db.Open(os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	svc := orders.NewService(pg.NewLegacyOrderStore(conn))
	if err := svc.Create(context.Background(), orders.Input{Ref: "seed", SKU: "OLD-0001", Quantity: 1}); err != nil {
		log.Fatal(err)
	}
}
`);
  set('internal/httpapi/ports.go', `package httpapi

import (
	"context"

	"${MOD}/internal/service/orders"
${DOMAINS.map((d) => `	"${MOD}/internal/service/${d}"`).join('\n')}
)

// OrderPlacer is what the order handlers need from the orders service.
type OrderPlacer interface {
	PlaceOrder(ctx context.Context, in ordering.CreateOrderInput) (ordering.Order, error)
	GetOrder(ctx context.Context, id string) (ordering.Order, error)
}
${DOMAINS.map((d) => { const T = cap(singular(d)); const p = singular(d).replace(/[^a-z]/g, ''); return `
// ${T}Service is what the ${d} handlers need.
type ${T}Service interface {
	Create${T}(ctx context.Context, in ${p}.Create${T}Input) (${p}.${T}, error)
	Get${T}(ctx context.Context, id string) (${p}.${T}, error)
}
`; }).join('')}`);
  set('internal/httpapi/respond.go', `package httpapi

import (
	"encoding/json"
	"net/http"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
`);
  set('internal/httpapi/router.go', `package httpapi

import (
	"net/http"

	"${MOD}/internal/middleware"
	"${MOD}/internal/platform/mux"
	orders "${MOD}/internal/service/orderlegacy"
)

// Deps are the services the HTTP API is built from (wired in internal/app).
type Deps struct {
	Orders   OrderPlacer
	Backfill *orders.Service
${DOMAINS.map((d) => `	${cap(d)} ${cap(singular(d))}Service`).join('\n')}
}

// NewRouter builds the whole HTTP surface.
func NewRouter(d Deps) http.Handler {
	root := mux.New()
	root.Route("/api", func(api *mux.Router) {
		api.Mount("/orders", orderRoutes(d.Orders))
${DOMAINS.map((d) => `		api.Mount("/${d}", ${singular(d)}Routes(d.${cap(d)}))`).join('\n')}
	})
	root.Route("/admin", func(admin *mux.Router) {
		admin.Mount("/orders", adminOrderRoutes(d.Backfill))
	})
	return middleware.Recoverer(middleware.Requestid(middleware.Logging(middleware.Auth(middleware.Cors(root)))))
}
`);
  set('internal/httpapi/orders_routes.go', `package httpapi

import "${MOD}/internal/platform/mux"

func orderRoutes(svc OrderPlacer) *mux.Router {
	r := mux.New()
	r.Post("/", handleCreateOrder(svc))
	r.Get("/{id}", handleGetOrder(svc))
	return r
}
`);
  set('internal/httpapi/handlers_orders.go', `package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"${MOD}/internal/platform/mux"
	"${MOD}/internal/service/orders"
)

// handleCreateOrder serves POST /api/orders.
func handleCreateOrder(svc OrderPlacer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in ordering.CreateOrderInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "malformed body")
			return
		}
		o, err := svc.PlaceOrder(r.Context(), in)
		switch {
		case errors.Is(err, ordering.ErrInvalidOrder):
			writeError(w, http.StatusBadRequest, err.Error())
		case err != nil:
			writeError(w, http.StatusInternalServerError, "could not place order")
		default:
			writeJSON(w, http.StatusCreated, o)
		}
	}
}

// handleGetOrder serves GET /api/orders/{id}.
func handleGetOrder(svc OrderPlacer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		o, err := svc.GetOrder(r.Context(), mux.Param(r, "id"))
		if errors.Is(err, ordering.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeJSON(w, http.StatusOK, o)
	}
}
`);
  set('internal/consumer/orders_consumer.go', `package consumer

import (
	"context"
	"encoding/json"

	"${MOD}/internal/service/orders"
)

// OrdersConsumer turns orders.create queue messages into placed orders.
type OrdersConsumer struct{ svc *ordering.Service }

// NewOrdersConsumer builds the consumer.
func NewOrdersConsumer(svc *ordering.Service) *OrdersConsumer { return &OrdersConsumer{svc: svc} }

// Handle processes one message body.
func (c *OrdersConsumer) Handle(ctx context.Context, body []byte) error {
	var in ordering.CreateOrderInput
	if err := json.Unmarshal(body, &in); err != nil {
		return err
	}
	_, err := c.svc.PlaceOrder(ctx, in)
	return err
}
`);
  set('internal/app/app.go', `package app

import (
	"net/http"

	"${MOD}/internal/consumer"
	"${MOD}/internal/events"
	"${MOD}/internal/httpapi"
	"${MOD}/internal/platform/config"
	"${MOD}/internal/platform/db"
	"${MOD}/internal/service/orderlegacy"
	"${MOD}/internal/service/orders"
${DOMAINS.map((d) => `	"${MOD}/internal/service/${d}"`).join('\n')}
	"${MOD}/internal/store/pg"
)

// App is the assembled service.
type App struct {
	cfg      config.Config
	handler  http.Handler
	consumer *consumer.OrdersConsumer
}

// New wires every layer: stores into services, services into the router and the consumer.
func New(cfg config.Config) *App {
	conn, err := db.Open(cfg.DatabaseURL)
	if err != nil {
		panic(err)
	}
	orderSvc := ordering.NewService(pg.NewOrderStore(conn), events.Nop{})
	deps := httpapi.Deps{
		Orders:   orderSvc,
		Backfill: orders.NewService(pg.NewLegacyOrderStore(conn)),
${DOMAINS.map((d) => `		${cap(d)}: ${singular(d).replace(/[^a-z]/g, '')}.NewService(pg.New${cap(singular(d))}Store(conn)),`).join('\n')}
	}
	return &App{cfg: cfg, handler: httpapi.NewRouter(deps), consumer: consumer.NewOrdersConsumer(orderSvc)}
}

// Run serves HTTP until the process stops.
func (a *App) Run() error { return http.ListenAndServe(a.cfg.Addr, a.handler) }
`);
  for (const d of DOMAINS) for (const [rel, text] of Object.entries(domainFiles(d))) set(rel, text);
  const tables = ['orders', 'legacy_orders', ...DOMAINS];
  tables.forEach((t, i) => set(`migrations/${String(i + 1).padStart(3, '0')}_${t}.sql`, `CREATE TABLE ${t} (\n  id TEXT PRIMARY KEY${t === 'orders' ? ',\n  customer_id TEXT NOT NULL,\n  sku TEXT NOT NULL,\n  quantity INT NOT NULL,\n  total_cents BIGINT NOT NULL,\n  placed_at TIMESTAMPTZ NOT NULL' : t === 'legacy_orders' ? ',\n  ref TEXT,\n  sku TEXT,\n  quantity INT' : ',\n  name TEXT NOT NULL'}\n);\n`));
  set('api/openapi.yaml', `openapi: 3.1.0\ninfo: { title: shopd, version: 1.4.0 }\npaths:\n  /api/orders:\n    post:\n      summary: Place an order\n      responses: { '201': { description: created }, '400': { description: invalid order } }\n${DOMAINS.map((d) => `  /api/${d}:\n    post: { summary: Create ${singular(d)} }\n`).join('')}`);

  const mustStay = ['internal/httpapi/handlers_orders.go', 'internal/httpapi/orders_routes.go', 'internal/httpapi/router.go', 'internal/store/pg/order_store.go', 'internal/store/pg/queries.go',
    'internal/consumer/orders_consumer.go', 'internal/service/orderlegacy/service.go', 'internal/store/pg/legacy_order_store.go', 'internal/httpapi/admin_orders.go', 'internal/app/app.go'];
  const unrelated = [...files.keys()].filter((f) => /^internal\/(service|store|httpapi)\//.test(f) && DOMAINS.some((d) => f.includes(d) || f.includes(singular(d))) && !mustStay.includes(f));
  return { files, meta: { mustStay, unrelated } };
}
