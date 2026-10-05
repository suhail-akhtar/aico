package ordering

// Hidden test for go-request-path. Run by the grader only when a Go toolchain
// is installed (the bench machine of 2026-10-05 had none; the static checks in
// task.mjs grade without it).

import (
	"context"
	"errors"
	"testing"

	"github.com/acme/shopd/internal/events"
)

type hiddenStore struct{ n int }

func (h *hiddenStore) Insert(context.Context, *Order) error  { h.n++; return nil }
func (h *hiddenStore) ByID(context.Context, string) (Order, error) { return Order{}, ErrNotFound }

func TestHiddenPlaceOrderValidates(t *testing.T) {
	cases := []struct {
		in CreateOrderInput
		ok bool
	}{
		{CreateOrderInput{SKU: "ABC-1234", Quantity: 1}, true},
		{CreateOrderInput{SKU: "ABC-1234", Quantity: 100}, true},
		{CreateOrderInput{SKU: "ABC-1234", Quantity: 0}, false},
		{CreateOrderInput{SKU: "ABC-1234", Quantity: 101}, false},
		{CreateOrderInput{SKU: "abc-1234", Quantity: 5}, false},
		{CreateOrderInput{SKU: "ABCD-1234", Quantity: 5}, false},
		{CreateOrderInput{SKU: "ABC-123", Quantity: 5}, false},
	}
	for _, c := range cases {
		store := &hiddenStore{}
		_, err := NewService(store, events.Nop{}).PlaceOrder(context.Background(), c.in)
		if c.ok && (err != nil || store.n != 1) {
			t.Errorf("%+v: want stored, got err=%v stored=%d", c.in, err, store.n)
		}
		if !c.ok && (!errors.Is(err, ErrInvalidOrder) || store.n != 0) {
			t.Errorf("%+v: want ErrInvalidOrder and nothing stored, got err=%v stored=%d", c.in, err, store.n)
		}
	}
}
