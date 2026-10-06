package com.example.system.identity.api;

import com.example.system.identity.AuthenticatedUser;
import com.example.system.shared.flags.FeatureFlags;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The bootstrap call of the single-page app: "am I signed in, who am I, what may I do, which
 * features are on for me". It is public so the app can render a sign-in page, and it never fails
 * with 401 for the simple reason that "not signed in" is an answer here, not an error.
 */
@RestController
@RequestMapping("/api/v1/session")
public class SessionController {

  /** What the browser may know about the caller. */
  public record UserView(UUID id, @Nullable String email, String name, Set<String> roles) {}

  /** The answer: {@code user} and {@code features} are present only when signed in. */
  public record SessionResponse(
      boolean authenticated, @Nullable UserView user, @Nullable Map<String, Object> features) {}

  private final FeatureFlags flags;

  public SessionController(FeatureFlags flags) {
    this.flags = flags;
  }

  @Operation(
      summary = "Who is calling, and which features are on for them",
      description = "Public. Answers authenticated=false instead of 401.")
  @SecurityRequirements
  @GetMapping
  public ResponseEntity<SessionResponse> session(@Nullable Authentication authentication) {
    SessionResponse body;
    if (authentication != null
        && authentication.isAuthenticated()
        && !(authentication instanceof AnonymousAuthenticationToken)) {
      AuthenticatedUser user = AuthenticatedUser.from(authentication);
      body =
          new SessionResponse(
              true,
              new UserView(user.id(), user.email(), user.name(), user.roles()),
              flags.snapshot(
                  FeatureFlags.contextFor(user.id().toString(), user.email(), user.roles())));
    } else {
      body = new SessionResponse(false, null, null);
    }
    // Per-user data: never cached by the browser or a shared proxy.
    return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
  }
}
