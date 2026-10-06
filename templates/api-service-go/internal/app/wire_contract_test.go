package app_test

import (
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

// One single-page app is generated from this API's OpenAPI document and also
// runs against the other starters, so the wire format is a contract: snake_case
// property names, `limit` and `cursor` for paging, `next_cursor` absent or null
// on the last page, `quantity` optional. This test replays it against the
// running service in both authentication modes, so a change that breaks the
// shared client fails here and not in the browser.

var snakeCase = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`)

func TestWireContractForTheSharedClient(t *testing.T) {
	t.Parallel()
	t.Run("local mode", func(t *testing.T) {
		t.Parallel()
		ta := newTestApp(t, nil)
		wireContract(t, ta, ta.signUp("ada@example.com"))
	})
	t.Run("oidc mode", func(t *testing.T) {
		t.Parallel()
		a := newOIDCApp(t)
		wireContract(t, a.testApp, a.token(subAda, "ada@example.com"))
	})
}

func wireContract(t *testing.T, ta *testApp, token string) {
	t.Helper()

	// GET /auth/me -> { id, email }
	me := ta.get("/v1/auth/me", token)
	assertKeys(t, "auth/me", me, []string{"id", "email"})

	// POST /items without quantity or description: both optional, quantity defaults to 0.
	created := ta.do(request{method: "POST", path: "/v1/items", token: token, body: map[string]any{"name": "minimal"}})
	if created.Code != 201 {
		t.Fatalf("create with only a name: %d %s", created.Code, created.Body)
	}
	assertKeys(t, "created item", created, []string{"id", "name", "description", "quantity", "created_at", "updated_at"})
	var it struct {
		ID          string    `json:"id"`
		Description *string   `json:"description"`
		Quantity    *int      `json:"quantity"`
		CreatedAt   time.Time `json:"created_at"`
	}
	created.json(t, &it)
	if it.Quantity == nil || *it.Quantity != 0 || it.CreatedAt.IsZero() {
		t.Fatalf("quantity must default to 0 and timestamps be date-times: %s", created.Body)
	}
	if loc := created.Header.Get("Location"); loc != "/v1/items/"+it.ID {
		t.Fatalf("Location = %q", loc)
	}

	// PUT is a full replace; a null description is accepted; no version field is required.
	put := ta.do(request{method: "PUT", path: "/v1/items/" + it.ID, token: token, body: `{"name":"renamed","description":null}`})
	if put.Code != 200 {
		t.Fatalf("PUT with a null description and no quantity: %d %s", put.Code, put.Body)
	}
	var replaced struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Quantity    int    `json:"quantity"`
	}
	put.json(t, &replaced)
	if replaced.Name != "renamed" || replaced.Description != "" || replaced.Quantity != 0 {
		t.Fatalf("PUT must replace every field: %s", put.Body)
	}
	full := ta.do(request{method: "POST", path: "/v1/items", token: token, body: map[string]any{"name": "full", "description": "d", "quantity": 1000000}})
	if full.Code != 201 {
		t.Fatalf("create with every field at its maximum: %d %s", full.Code, full.Body)
	}

	// Paging: `limit` and `cursor`, newest first, a walk over more than one page.
	for i := range 5 {
		ta.clock.Advance(time.Millisecond)
		ta.createItem(token, fmt.Sprintf("walk-%d", i))
	}
	var names []string
	path, pages := "/v1/items?limit=3", 0
	for {
		r := ta.get(path, token)
		if r.Code != 200 {
			t.Fatalf("page %d: %d %s", pages, r.Code, r.Body)
		}
		var page struct {
			Items      []itemJSON `json:"items"`
			NextCursor *string    `json:"next_cursor"`
		}
		r.json(t, &page)
		assertKeys(t, "list page", r, nil)
		pages++
		for _, item := range page.Items {
			names = append(names, item.Name)
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			break // null or absent on the last page
		}
		path = "/v1/items?limit=3&cursor=" + *page.NextCursor
		if pages > 10 {
			t.Fatal("the cursor walk does not terminate")
		}
	}
	want := []string{"walk-4", "walk-3", "walk-2", "walk-1", "walk-0", "full", "renamed"}
	if diff := cmp.Diff(want, names); diff != "" || pages != 3 {
		t.Fatalf("pages = %d (-want +got):\n%s", pages, diff)
	}
	if r := ta.get("/v1/items?limit=100", token); r.Code != 200 {
		t.Fatalf("limit=100: %d", r.Code)
	}

	// Errors are application/problem+json with type, title and status.
	for name, r := range map[string]response{
		"unauthenticated": ta.get("/v1/items", ""),
		"not found":       ta.get("/v1/items/0199a8c4-3f6e-7b21-8c3d-0123456789ab", token),
		"validation":      ta.do(request{method: "POST", path: "/v1/items", token: token, body: map[string]any{"name": ""}}),
	} {
		p := r.problem(t)
		if p.Type == "" || p.Title == "" || p.Status != r.Code {
			t.Errorf("%s: %+v", name, p)
		}
		assertKeys(t, name+" problem", r, nil)
	}

	// DELETE answers 204 and then 404.
	if r := ta.do(request{method: "DELETE", path: "/v1/items/" + it.ID, token: token}); r.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", r.Code)
	}
	if r := ta.get("/v1/items/"+it.ID, token); r.Code != 404 {
		t.Fatalf("get after delete: %d", r.Code)
	}
}

// assertKeys checks that every property name in a JSON response (at any depth)
// is snake_case and, when want is non-nil, that the top-level object has
// exactly those properties.
func assertKeys(t *testing.T, what string, r response, want []string) {
	t.Helper()
	var v any
	r.json(t, &v)
	var walk func(path string, v any)
	walk = func(path string, v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, child := range x {
				if !snakeCase.MatchString(k) {
					t.Errorf("%s: property %q at %s is not snake_case", what, k, path)
				}
				walk(path+"."+k, child)
			}
		case []any:
			for i, child := range x {
				walk(fmt.Sprintf("%s[%d]", path, i), child)
			}
		}
	}
	walk("$", v)
	if want == nil {
		return
	}
	top, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("%s: not a JSON object: %s", what, r.Body)
	}
	var got []string
	for k := range top {
		got = append(got, k)
	}
	slices.Sort(got)
	slices.Sort(want)
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("%s: properties differ (-want +got):\n%s", what, diff)
	}
}
