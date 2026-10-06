package auth

import (
	"context"

	"example.com/api-service/internal/api"
	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/identity"
)

var errUnsupportedMedia = apperr.New(apperr.KindUnsupportedMediaType, "the request body must be application/json")

// Handler is the HTTP adapter for the auth operations of the generated
// api.StrictServerInterface.
type Handler struct {
	svc *Service
}

// NewHandler returns the auth operations backed by svc.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// Register implements POST /v1/auth/register.
func (h *Handler) Register(ctx context.Context, req api.RegisterRequestObject) (api.RegisterResponseObject, error) {
	if !h.svc.LocalAuthEnabled() {
		return nil, ErrLocalAuthDisabled
	}
	if req.Body == nil {
		return nil, errUnsupportedMedia
	}
	u, err := h.svc.Register(ctx, req.Body.Email, deref(req.Body.Password))
	if err != nil {
		return nil, err
	}
	return api.Register201JSONResponse{Id: u.ID, Email: u.Email, CreatedAt: u.CreatedAt}, nil
}

// Login implements POST /v1/auth/login.
func (h *Handler) Login(ctx context.Context, req api.LoginRequestObject) (api.LoginResponseObject, error) {
	if !h.svc.LocalAuthEnabled() {
		return nil, ErrLocalAuthDisabled
	}
	if req.Body == nil {
		return nil, errUnsupportedMedia
	}
	tok, err := h.svc.Login(ctx, req.Body.Email, deref(req.Body.Password))
	if err != nil {
		return nil, err
	}
	return api.Login200JSONResponse{AccessToken: tok.Value, TokenType: api.Bearer, ExpiresAt: tok.ExpiresAt}, nil
}

// Logout implements POST /v1/auth/logout. The middleware already proved the
// token is live; the token itself travels in the context so it can be revoked.
func (h *Handler) Logout(ctx context.Context, _ api.LogoutRequestObject) (api.LogoutResponseObject, error) {
	if !h.svc.LocalAuthEnabled() {
		return nil, ErrLocalAuthDisabled
	}
	token, ok := TokenFromContext(ctx)
	if !ok {
		return nil, ErrInvalidToken
	}
	if err := h.svc.Logout(ctx, token); err != nil {
		return nil, err
	}
	return api.Logout204Response{}, nil
}

// GetMe implements GET /v1/auth/me.
func (h *Handler) GetMe(ctx context.Context, _ api.GetMeRequestObject) (api.GetMeResponseObject, error) {
	p, ok := identity.FromContext(ctx)
	if !ok {
		return nil, ErrInvalidToken
	}
	return api.GetMe200JSONResponse{Id: p.UserID, Email: p.Email}, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
