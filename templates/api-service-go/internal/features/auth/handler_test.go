package auth_test

import (
	"context"
	"errors"
	"testing"

	"example.com/api-service/internal/api"
	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/identity"
)

// The handler is exercised end to end through HTTP in internal/app. These tests
// cover the guards that HTTP cannot reach because the generated server or the
// middleware stands in front of them.

func TestHandlerRefusesAMissingBody(t *testing.T) {
	t.Parallel()
	h := auth.NewHandler(newEnv(t).svc)
	_, err := h.Register(context.Background(), api.RegisterRequestObject{})
	if apperr.KindOf(err) != apperr.KindUnsupportedMediaType {
		t.Errorf("Register without a body: %v", err)
	}
	_, err = h.Login(context.Background(), api.LoginRequestObject{})
	if apperr.KindOf(err) != apperr.KindUnsupportedMediaType {
		t.Errorf("Login without a body: %v", err)
	}
}

func TestHandlerTreatsAMissingPasswordAsEmpty(t *testing.T) {
	t.Parallel()
	h := auth.NewHandler(newEnv(t).svc)
	_, err := h.Register(context.Background(), api.RegisterRequestObject{Body: &api.Credentials{Email: "ada@example.com"}})
	if _, ok := fields(t, err)["password"]; !ok {
		t.Errorf("Register without a password: %v", err)
	}
	_, err = h.Login(context.Background(), api.LoginRequestObject{Body: &api.Credentials{Email: "ada@example.com"}})
	if _, ok := fields(t, err)["password"]; !ok {
		t.Errorf("Login without a password: %v", err)
	}
}

func TestLogoutAndMeFailClosedWithoutContext(t *testing.T) {
	t.Parallel()
	h := auth.NewHandler(newEnv(t).svc)
	if _, err := h.Logout(context.Background(), api.LogoutRequestObject{}); !errors.Is(err, auth.ErrInvalidToken) {
		t.Errorf("Logout without a token in the context: %v", err)
	}
	if _, err := h.GetMe(context.Background(), api.GetMeRequestObject{}); !errors.Is(err, auth.ErrInvalidToken) {
		t.Errorf("GetMe without a principal: %v", err)
	}
	ctx := identity.WithPrincipal(context.Background(), identity.Principal{UserID: "u", Email: "a@example.com"})
	res, err := h.GetMe(ctx, api.GetMeRequestObject{})
	if err != nil {
		t.Fatal(err)
	}
	if me, ok := res.(api.GetMe200JSONResponse); !ok || me.Email != "a@example.com" || me.Id != "u" {
		t.Errorf("GetMe = %#v", res)
	}
}
