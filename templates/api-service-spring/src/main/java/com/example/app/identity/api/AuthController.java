package com.example.app.identity.api;

import com.example.app.identity.app.AuthService;
import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.TokenIssuer.IssuedToken;
import com.example.app.shared.security.AuthenticatedUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * HTTP edge of the identity feature: register, log in, read the current account. In {@code
 * APP_AUTH_MODE=oidc} the first two answer 404 (accounts and passwords belong to the identity
 * provider; see {@link LocalAuthGuard}) and only {@code /me} works. JSON names are snake_case
 * ({@code access_token}, {@code expires_in}) through the Jackson naming strategy.
 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

  /** Registration form. The domain applies the real password policy and reports every field. */
  public record RegisterRequest(
      @NotBlank @Email @Size(max = 254) String email, @NotBlank @Size(max = 128) String password) {}

  /** Login form. */
  public record LoginRequest(
      @NotBlank @Size(max = 254) String email, @NotBlank @Size(max = 128) String password) {}

  /** A bearer token and its lifetime. */
  public record TokenResponse(String accessToken, String tokenType, long expiresIn) {}

  /** The public view of an account (never the hash). */
  public record AccountResponse(UUID id, String email, Instant createdAt) {

    static AccountResponse from(Account account) {
      return new AccountResponse(account.id(), account.email(), account.createdAt());
    }
  }

  private final AuthService service;

  public AuthController(AuthService service) {
    this.service = service;
  }

  @Operation(summary = "Register a new account")
  @SecurityRequirements
  @ApiResponse(responseCode = "201", description = "Account created")
  @ApiResponse(responseCode = "409", description = "Email already registered")
  @PostMapping("/register")
  @ResponseStatus(HttpStatus.CREATED)
  public AccountResponse register(@Valid @RequestBody RegisterRequest request) {
    return AccountResponse.from(service.register(request.email(), request.password()));
  }

  @Operation(summary = "Exchange email and password for an access token")
  @SecurityRequirements
  @ApiResponse(responseCode = "401", description = "Invalid email or password")
  @PostMapping("/login")
  public TokenResponse login(@Valid @RequestBody LoginRequest request) {
    IssuedToken token = service.login(request.email(), request.password());
    return new TokenResponse(token.value(), "Bearer", token.expiresInSeconds());
  }

  @Operation(summary = "The account the access token belongs to")
  @GetMapping("/me")
  public AccountResponse me(@AuthenticationPrincipal Jwt jwt) {
    return AccountResponse.from(service.get(AuthenticatedUser.id(jwt)));
  }
}
