package app_test

import (
	"bytes"
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"

	apispec "example.com/api-service/api"
	"example.com/api-service/internal/app"
)

// loadSpec parses and validates api/openapi.yaml, the contract the server was
// generated from, and returns it with a router that finds operations by request.
func loadSpec(t *testing.T) (*openapi3.T, routers.Router) {
	t.Helper()
	doc, err := openapi3.NewLoader().LoadFromData(apispec.YAML)
	if err != nil {
		t.Fatalf("openapi.yaml does not parse: %v", err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("openapi.yaml is not a valid OpenAPI document: %v", err)
	}
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatal(err)
	}
	return doc, router
}

func TestOpenAPIDocumentIsValid(t *testing.T) {
	t.Parallel()
	doc, _ := loadSpec(t)
	if doc.Info == nil || doc.Info.Version == "" || len(doc.Paths.Map()) < 8 {
		t.Fatalf("the document looks empty: %+v", doc.Info)
	}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			if op.OperationID == "" {
				t.Errorf("%s %s has no operationId (the generated interface needs one)", method, path)
			}
			if _, ok := op.Responses.Map()["200"]; !ok && op.Responses.Status(201) == nil && op.Responses.Status(204) == nil {
				t.Errorf("%s %s documents no success response", method, path)
			}
		}
	}
}

// The authentication gate is deny-by-default; its allow-list lives in code. This
// test keeps that list identical to the operations the document marks public
// (`security: []`), so a route cannot become public, or protected, by accident.
func TestPublicRoutesMatchTheDocument(t *testing.T) {
	t.Parallel()
	doc, _ := loadSpec(t)
	want := map[string]bool{}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			secured := true
			if op.Security != nil {
				secured = len(*op.Security) > 0
			} else if len(doc.Security) == 0 {
				secured = false
			}
			if !secured {
				want[method+" "+path] = true
			}
		}
	}
	got := app.PublicRoutes()
	for route := range want {
		if !got[route] {
			t.Errorf("%s is public in the document but protected in code", route)
		}
	}
	for route := range got {
		if !want[route] {
			t.Errorf("%s is public in code but protected in the document", route)
		}
	}
}

// Every operation in the document must be reachable (not the catch-all 404/405),
// and every one that requires a token must refuse a request without one.
func TestEveryDocumentedOperationIsRoutedAndGated(t *testing.T) {
	t.Parallel()
	doc, _ := loadSpec(t)
	ta := newTestApp(t, nil)
	public := app.PublicRoutes()
	id := "0199a8c4-3f6e-7b21-8c3d-0123456789ab"
	for path, item := range doc.Paths.Map() {
		for method := range item.Operations() {
			url := strings.ReplaceAll(path, "{id}", id)
			r := ta.do(request{method: method, path: url, body: map[string]any{"name": "x", "email": "a@example.com", "password": testPassword}})
			if public[method+" "+path] {
				// A public operation must be routed; it may still answer 401 for bad
				// credentials (login), which is why 401 is not checked here.
				if r.Code == 404 || r.Code == 405 {
					t.Errorf("%s %s is documented public but answered %d", method, path, r.Code)
				}
				continue
			}
			if r.Code != 401 {
				t.Errorf("%s %s requires a token but answered %d without one", method, path, r.Code)
			}
		}
	}
}

// TestResponsesMatchTheDocument replays a scenario that touches every operation,
// including the error paths, and validates each real response (status, headers,
// content type and JSON body) against the OpenAPI document.
func TestResponsesMatchTheDocument(t *testing.T) {
	t.Parallel()
	_, router := loadSpec(t)
	ta := newTestApp(t, nil)

	creds := map[string]string{"email": "ada@example.com", "password": testPassword}
	ta.do(request{method: "POST", path: "/v1/auth/register", body: creds})
	ta.do(request{method: "POST", path: "/v1/auth/register", body: creds})                                                        // 409
	ta.do(request{method: "POST", path: "/v1/auth/register", body: map[string]string{"email": "x", "password": "y"}})             // 422
	ta.do(request{method: "POST", path: "/v1/auth/register", body: "{"})                                                          // 400
	ta.do(request{method: "POST", path: "/v1/auth/login", body: map[string]string{"email": "ada@example.com", "password": "no"}}) // 401 (and 422 below)
	ta.do(request{method: "POST", path: "/v1/auth/login", body: map[string]string{"email": "ada@example.com", "password": strings.Repeat("x", 200)}})
	tok := ta.signUp("grace@example.com")
	ta.get("/v1/auth/me", tok)
	ta.get("/v1/auth/me", "")
	for i := range 3 {
		ta.createItem(tok, fmt.Sprintf("item-%d", i))
	}
	first := ta.createItem(tok, "target")
	ta.get("/v1/items", tok)
	ta.get("/v1/items?limit=1", tok)
	ta.get("/v1/items?limit=0", tok)                                                                                                             // 422
	ta.get("/v1/items?limit=abc", tok)                                                                                                           // 400
	ta.get("/v1/items", "")                                                                                                                      // 401
	ta.get("/v1/items/"+first.ID, tok)                                                                                                           // 200
	ta.get("/v1/items/not-an-id", tok)                                                                                                           // 404
	ta.get("/v1/items/"+first.ID, "")                                                                                                            // 401
	ta.do(request{method: "POST", path: "/v1/items", token: tok, body: map[string]any{"name": ""}})                                              // 422
	ta.do(request{method: "POST", path: "/v1/items", token: tok, body: "{"})                                                                     // 400
	ta.do(request{method: "POST", path: "/v1/items", token: tok, body: `{"name":"x"}`, header: map[string]string{"Content-Type": "text/plain"}}) // 415
	ta.do(request{method: "POST", path: "/v1/items", token: tok, body: strings.Repeat("a", 5000)})                                               // 413
	ta.do(request{method: "PUT", path: "/v1/items/" + first.ID, token: tok, body: map[string]any{"name": "renamed"}})
	ta.do(request{method: "PUT", path: "/v1/items/" + first.ID, token: tok, body: map[string]any{"name": ""}})
	ta.do(request{method: "PUT", path: "/v1/items/0199a8c4-3f6e-7b21-8c3d-0123456789ab", token: tok, body: map[string]any{"name": "x"}}) // 404
	ta.do(request{method: "DELETE", path: "/v1/items/" + first.ID, token: tok})
	ta.do(request{method: "DELETE", path: "/v1/items/" + first.ID, token: tok}) // 404
	ta.get("/healthz", "")
	ta.get("/readyz", "")
	ta.pinged = func() error { return fmt.Errorf("down") }
	ta.get("/readyz", "") // 503
	ta.get("/openapi.yaml", "")
	ta.do(request{method: "POST", path: "/v1/auth/logout", token: tok})
	ta.do(request{method: "POST", path: "/v1/auth/logout", token: tok}) // 401 now

	validated, statuses := 0, map[int]bool{}
	for _, ex := range ta.exchanges {
		req := httptest.NewRequestWithContext(context.Background(), ex.method, ex.uri, bytes.NewReader(ex.body))
		route, pathParams, err := router.FindRoute(req)
		if err != nil {
			continue // 404/405 from the catch-all: no operation to validate against
		}
		if ex.uri == "/openapi.yaml" {
			continue // a YAML file, not a JSON body
		}
		in := &openapi3filter.RequestValidationInput{Request: req, PathParams: pathParams, Route: route}
		out := &openapi3filter.ResponseValidationInput{
			RequestValidationInput: in,
			Status:                 ex.response.Code,
			Header:                 ex.response.Header,
			Options:                &openapi3filter.Options{IncludeResponseStatus: true},
		}
		out.SetBodyBytes(ex.response.Body)
		if err := openapi3filter.ValidateResponse(context.Background(), out); err != nil {
			t.Errorf("%s %s -> %d does not match the document: %v\nbody: %s", ex.method, ex.uri, ex.response.Code, err, ex.response.Body)
			continue
		}
		validated++
		statuses[ex.response.Code] = true
	}
	if validated < 25 {
		t.Fatalf("only %d exchanges were validated; the scenario is not exercising the API", validated)
	}
	for _, code := range []int{200, 201, 204, 400, 401, 404, 409, 413, 415, 422, 503} {
		if !statuses[code] {
			t.Errorf("the scenario never produced a validated %d response", code)
		}
	}
}

// TestRequestLimitsInTheDocumentMatchTheService feeds boundary values to both
// the document's schema and the live API. If someone changes a limit in one
// place only, the two verdicts disagree and this fails.
func TestRequestLimitsInTheDocumentMatchTheService(t *testing.T) {
	t.Parallel()
	_, router := loadSpec(t)
	ta := newTestApp(t, map[string]string{"MAX_BODY_BYTES": "65536"})
	tok := ta.signUp("ada@example.com")

	specAccepts := func(method, path, body string) bool {
		req := httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		route, params, err := router.FindRoute(req)
		if err != nil {
			t.Fatalf("no route for %s %s: %v", method, path, err)
		}
		return openapi3filter.ValidateRequest(context.Background(), &openapi3filter.RequestValidationInput{
			Request: req, PathParams: params, Route: route,
			Options: &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc},
		}) == nil
	}

	type probe struct{ name, method, path, body string }
	probes := []probe{
		{"name 120", "POST", "/v1/items", fmt.Sprintf(`{"name":%q}`, strings.Repeat("n", 120))},
		{"name 121", "POST", "/v1/items", fmt.Sprintf(`{"name":%q}`, strings.Repeat("n", 121))},
		{"name empty", "POST", "/v1/items", `{"name":""}`},
		{"description 1000", "POST", "/v1/items", fmt.Sprintf(`{"name":"a","description":%q}`, strings.Repeat("d", 1000))},
		{"description 1001", "POST", "/v1/items", fmt.Sprintf(`{"name":"a","description":%q}`, strings.Repeat("d", 1001))},
		{"quantity 0", "POST", "/v1/items", `{"name":"a","quantity":0}`},
		{"quantity max", "POST", "/v1/items", `{"name":"a","quantity":1000000}`},
		{"quantity max+1", "POST", "/v1/items", `{"name":"a","quantity":1000001}`},
		{"quantity -1", "POST", "/v1/items", `{"name":"a","quantity":-1}`},
		{"update name 121", "PUT", "/v1/items/0199a8c4-3f6e-7b21-8c3d-0123456789ab", fmt.Sprintf(`{"name":%q}`, strings.Repeat("n", 121))},
		{"register password 11", "POST", "/v1/auth/register", fmt.Sprintf(`{"email":"a@example.com","password":%q}`, strings.Repeat("p", 11))},
		{"register password 12", "POST", "/v1/auth/register", fmt.Sprintf(`{"email":"b@example.com","password":%q}`, strings.Repeat("p", 12))},
		{"register password 128", "POST", "/v1/auth/register", fmt.Sprintf(`{"email":"c@example.com","password":%q}`, strings.Repeat("p", 128))},
		{"register password 129", "POST", "/v1/auth/register", fmt.Sprintf(`{"email":"d@example.com","password":%q}`, strings.Repeat("p", 129))},
	}
	for _, p := range probes {
		spec := specAccepts(p.method, p.path, p.body)
		r := ta.do(request{method: p.method, path: p.path, token: tok, body: p.body})
		serviceAccepts := r.Code < 400 || r.Code == 404 // an unknown (but well-formed) item id is not a validation failure
		if spec != serviceAccepts {
			t.Errorf("%s: the document says valid=%v but the API answered %d: %s", p.name, spec, r.Code, r.Body)
		}
	}
}

func TestRequestValidationRejectsUnknownFieldsInTheDocumentOnly(t *testing.T) {
	t.Parallel()
	// The document says additionalProperties: false on request bodies, which
	// tells clients not to send extras. The server is lenient (extras are
	// ignored, and cannot reach server-owned fields: see
	// TestMassAssignmentIsImpossible). This test records that decision.
	_, router := loadSpec(t)
	req := httptest.NewRequestWithContext(context.Background(), "POST", "/v1/items", strings.NewReader(`{"name":"a","owner_id":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	route, params, err := router.FindRoute(req)
	if err != nil {
		t.Fatal(err)
	}
	err = openapi3filter.ValidateRequest(context.Background(), &openapi3filter.RequestValidationInput{
		Request: req, PathParams: params, Route: route,
		Options: &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc},
	})
	if err == nil {
		t.Fatal("the document must forbid additional properties on request bodies")
	}
}
