package com.example.system.identity.security;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.oidc.web.logout.OidcClientInitiatedLogoutSuccessHandler;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import tools.jackson.databind.json.JsonMapper;

/**
 * RP-initiated logout for a single-page app. The session is already gone when this runs; the
 * identity provider's own session must end too, which needs a browser navigation to its end-session
 * URL (with the ID-token hint). A redirect cannot be followed by {@code fetch} across origins, so
 * this answers 200 with {@code {"redirect": "<url>"}} and the SPA navigates there. For a caller
 * with no OIDC session the target is simply the site root.
 */
final class JsonOidcLogoutSuccessHandler extends OidcClientInitiatedLogoutSuccessHandler {

  private final JsonMapper json;

  JsonOidcLogoutSuccessHandler(ClientRegistrationRepository registrations, JsonMapper json) {
    super(registrations);
    this.json = json;
    setPostLogoutRedirectUri("{baseUrl}/");
  }

  @Override
  public void onLogoutSuccess(
      HttpServletRequest request, HttpServletResponse response, @Nullable Authentication auth)
      throws IOException {
    String target = determineTargetUrl(request, response, auth);
    response.setStatus(HttpServletResponse.SC_OK);
    response.setContentType(MediaType.APPLICATION_JSON_VALUE);
    response.getWriter().write(json.writeValueAsString(Map.of("redirect", target)));
  }
}
