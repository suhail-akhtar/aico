package items_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"

	"example.com/api-service/internal/features/items"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/ids"
	"example.com/api-service/internal/platform/validate"
)

const owner = "0199a8c4-3f6e-7b21-8c3d-00000000000a"

func newService(t *testing.T) (*items.Service, *clock.Fake) {
	t.Helper()
	fake := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	return items.NewService(items.NewMemoryRepository(), ids.NewGenerator(fake), fake), fake
}

func fieldsOf(t *testing.T, err error) map[string]string {
	t.Helper()
	var verrs validate.Errors
	if !errors.As(err, &verrs) {
		t.Fatalf("want validation errors, got %v", err)
	}
	m := map[string]string{}
	for _, f := range verrs {
		m[f.Field] = f.Message
	}
	return m
}

func TestCreateStampsServerOwnedFields(t *testing.T) {
	t.Parallel()
	svc, fake := newService(t)
	it, err := svc.Create(context.Background(), owner, items.Input{Name: "  pen  ", Description: "blue", Quantity: 2})
	if err != nil {
		t.Fatal(err)
	}
	want := items.Item{ID: it.ID, OwnerID: owner, Name: "pen", Description: "blue", Quantity: 2, CreatedAt: fake.Now(), UpdatedAt: fake.Now()}
	if diff := cmp.Diff(want, it); diff != "" {
		t.Fatalf("(-want +got):\n%s", diff)
	}
	if !ids.Valid(it.ID) {
		t.Fatalf("id %q is not a UUID", it.ID)
	}
}

func TestValidation(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		in        items.Input
		wantField string
	}{
		{"empty name", items.Input{Name: ""}, "name"},
		{"blank name", items.Input{Name: " \t\n "}, "name"},
		{"name too long", items.Input{Name: strings.Repeat("x", items.MaxNameLen+1)}, "name"},
		{"name has NUL", items.Input{Name: "a\x00b"}, "name"},
		{"description too long", items.Input{Name: "ok", Description: strings.Repeat("x", items.MaxDescriptionLen+1)}, "description"},
		{"description has NUL", items.Input{Name: "ok", Description: "a\x00b"}, "description"},
		{"negative quantity", items.Input{Name: "ok", Quantity: -1}, "quantity"},
		{"huge quantity", items.Input{Name: "ok", Quantity: items.MaxQuantity + 1}, "quantity"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			svc, _ := newService(t)
			_, err := svc.Create(context.Background(), owner, tt.in)
			if _, ok := fieldsOf(t, err)[tt.wantField]; !ok {
				t.Fatalf("no error for %q: %v", tt.wantField, err)
			}
			if _, err := svc.Update(context.Background(), owner, "0199a8c4-3f6e-7b21-8c3d-0123456789ab", tt.in); !errors.As(err, new(validate.Errors)) {
				t.Fatalf("Update must validate too: %v", err)
			}
		})
	}
}

func TestLengthIsCountedInCharactersNotBytes(t *testing.T) {
	t.Parallel()
	svc, _ := newService(t)
	if _, err := svc.Create(context.Background(), owner, items.Input{Name: strings.Repeat("\U0001F600", items.MaxNameLen)}); err != nil {
		t.Fatalf("120 emoji (480 bytes) must be accepted: %v", err)
	}
	if _, err := svc.Create(context.Background(), owner, items.Input{Name: strings.Repeat("\U0001F600", items.MaxNameLen+1)}); err == nil {
		t.Fatal("121 emoji must be refused")
	}
}

func TestMalformedIDsAreNotFoundNotErrors(t *testing.T) {
	t.Parallel()
	svc, _ := newService(t)
	ctx := context.Background()
	for _, id := range []string{"", "1", "../../etc/passwd", "0199a8c4-3f6e-7b21-8c3d-0123456789AB", "' OR 1=1 --"} {
		if _, err := svc.Get(ctx, owner, id); !errors.Is(err, items.ErrNotFound) {
			t.Errorf("Get(%q) = %v", id, err)
		}
		if _, err := svc.Update(ctx, owner, id, items.Input{Name: "x"}); !errors.Is(err, items.ErrNotFound) {
			t.Errorf("Update(%q) = %v", id, err)
		}
		if err := svc.Delete(ctx, owner, id); !errors.Is(err, items.ErrNotFound) {
			t.Errorf("Delete(%q) = %v", id, err)
		}
	}
}

func TestUpdateAndDelete(t *testing.T) {
	t.Parallel()
	svc, fake := newService(t)
	ctx := context.Background()
	it, _ := svc.Create(ctx, owner, items.Input{Name: "pen"})
	fake.Advance(time.Hour)
	up, err := svc.Update(ctx, owner, it.ID, items.Input{Name: "marker", Quantity: 4})
	if err != nil {
		t.Fatal(err)
	}
	if up.Name != "marker" || up.Quantity != 4 || !up.UpdatedAt.After(up.CreatedAt) || !up.CreatedAt.Equal(it.CreatedAt) {
		t.Fatalf("unexpected update result: %+v", up)
	}
	if err := svc.Delete(ctx, owner, it.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(ctx, owner, it.ID); !errors.Is(err, items.ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}

func TestListPagination(t *testing.T) {
	t.Parallel()
	svc, _ := newService(t)
	ctx := context.Background()
	for _, name := range []string{"a", "b", "c", "d", "e"} {
		if _, err := svc.Create(ctx, owner, items.Input{Name: name}); err != nil {
			t.Fatal(err)
		}
	}

	var got []string
	cursor, pages := "", 0
	for {
		page, err := svc.List(ctx, owner, 2, cursor)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		for _, it := range page.Items {
			got = append(got, it.Name)
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if diff := cmp.Diff([]string{"e", "d", "c", "b", "a"}, got); diff != "" || pages != 3 {
		t.Fatalf("pages=%d (-want +got):\n%s", pages, diff)
	}

	if page, _ := svc.List(ctx, owner, 5, ""); page.NextCursor != "" || len(page.Items) != 5 {
		t.Fatalf("a page that exactly fits must have no next cursor: %+v", page)
	}
	if page, _ := svc.List(ctx, owner, 0, ""); len(page.Items) != 5 {
		t.Fatalf("default limit returned %d items", len(page.Items))
	}
}

func TestListValidation(t *testing.T) {
	t.Parallel()
	svc, _ := newService(t)
	for _, tt := range []struct {
		name   string
		limit  int
		cursor string
		field  string
	}{
		{"limit too small", -1, "", "limit"},
		{"limit too large", 101, "", "limit"},
		{"cursor garbage", 10, "garbage!", "cursor"},
	} {
		_, err := svc.List(context.Background(), owner, tt.limit, tt.cursor)
		if _, ok := fieldsOf(t, err)[tt.field]; !ok {
			t.Errorf("%s: no error for %s: %v", tt.name, tt.field, err)
		}
	}
}

type failingRepo struct{ items.Repository }

var errBoom = errors.New("boom")

func (failingRepo) Create(context.Context, items.Item) error { return errBoom }
func (failingRepo) List(context.Context, string, string, int) ([]items.Item, error) {
	return nil, errBoom
}

func TestRepositoryFailuresAreWrapped(t *testing.T) {
	t.Parallel()
	fake := clock.NewFake(time.Now())
	svc := items.NewService(failingRepo{items.NewMemoryRepository()}, ids.NewGenerator(fake), fake)
	if _, err := svc.Create(context.Background(), owner, items.Input{Name: "x"}); !errors.Is(err, errBoom) {
		t.Errorf("Create: %v", err)
	}
	if _, err := svc.List(context.Background(), owner, 5, ""); !errors.Is(err, errBoom) {
		t.Errorf("List: %v", err)
	}
}
