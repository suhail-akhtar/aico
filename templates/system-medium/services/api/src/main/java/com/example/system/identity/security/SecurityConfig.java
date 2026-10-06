package com.example.system.identity.security;

import com.example.system.identity.domain.UserDirectory;
import com.example.system.shared.config.AppProperties;
import com.example.system.shared.web.BodySizeLimitFilter;
import com.example.system.shared.web.RateLimitConfig.RateLimiters;
import com.example.system.shared.web.RateLimitFilter;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Objects;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.convert.converter.Converter;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.oauth2.client.oidc.userinfo.OidcUserRequest;
import org.springframework.security.oauth2.client.oidc.userinfo.OidcUserService;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.client.web.DefaultOAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestCustomizers;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.core.oidc.user.DefaultOidcUser;
import org.springframework.security.oauth2.core.oidc.user.OidcUser;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.SupplierJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.logout.LogoutSuccessHandler;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.header.writers.CrossOriginOpenerPolicyHeaderWriter;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter;
import org.springframework.web.servlet.HandlerExceptionResolver;
import tools.jackson.databind.json.JsonMapper;

/**
 * The security model, in one place.
 *
 * <p><b>Browsers</b> sign in with OpenID Connect (authorization code + PKCE, a confidential client)
 * and receive only an opaque, HttpOnly session cookie; the tokens stay on the server (RFC 10017's
 * backend-for-frontend). The session lives in Valkey, so any replica can serve any request. Cookie
 * authentication means CSRF protection is on: the SPA reads the {@code XSRF-TOKEN} cookie and
 * echoes it in {@code X-XSRF-TOKEN}.
 *
 * <p><b>Machine clients</b> send {@code Authorization: Bearer} with a token from the same provider
 * (client credentials); the token is verified against the provider's keys, issuer, expiry and
 * audience, and CSRF does not apply because a browser cannot attach that header cross-site.
 *
 * <p>Everything is denied unless listed. Errors leave through the same RFC 9457 handler as every
 * other failure. Method security ({@code @PreAuthorize}) repeats the role rule on the admin
 * endpoints so a mistake in a path pattern is not the only line of defence.
 */
@Configuration(proxyBeanMethods = false)
@EnableWebSecurity
@EnableMethodSecurity
class SecurityConfig {

  private static final String CSP = "default-src 'none'; frame-ancestors 'none'";

  @Bean
  SecurityFilterChain securityFilterChain(
      HttpSecurity http,
      AppProperties props,
      RateLimiters limiters,
      OAuth2UserService<OidcUserRequest, OidcUser> oidcUserService,
      Converter<Jwt, AbstractAuthenticationToken> jwtConverter,
      LogoutSuccessHandler logoutSuccessHandler,
      ClientRegistrationRepository clients,
      @Qualifier("handlerExceptionResolver") HandlerExceptionResolver resolver)
      throws Exception {
    var bodyLimit =
        new BodySizeLimitFilter(
            props.http().maxBodySize().toBytes(),
            props.http().maxUploadSize().toBytes(),
            SecurityConfig::isUpload,
            resolver);
    var rateLimit = new RateLimitFilter(limiters.api(), limiters.auth(), resolver);

    http.csrf(csrf -> csrf.spa().ignoringRequestMatchers(SecurityConfig::carriesBearerToken))
        .headers(
            h ->
                h.httpStrictTransportSecurity(
                        hsts ->
                            hsts.includeSubDomains(true).preload(true).maxAgeInSeconds(63_072_000))
                    .referrerPolicy(
                        r ->
                            r.policy(
                                ReferrerPolicyHeaderWriter.ReferrerPolicy
                                    .STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
                    .crossOriginOpenerPolicy(
                        c ->
                            c.policy(
                                CrossOriginOpenerPolicyHeaderWriter.CrossOriginOpenerPolicy
                                    .SAME_ORIGIN))
                    .addHeaderWriter(
                        (request, response) -> {
                          // The API explorer needs scripts and styles; the JSON API does not. A
                          // response that already chose its own policy (a download) keeps it.
                          if (!request.getRequestURI().startsWith("/swagger-ui")
                              && response.getHeader("Content-Security-Policy") == null) {
                            response.setHeader("Content-Security-Policy", CSP);
                          }
                          response.setHeader(
                              "Permissions-Policy", "camera=(), microphone=(), geolocation=()");
                        }))
        .authorizeHttpRequests(
            a ->
                a.dispatcherTypeMatchers(DispatcherType.ERROR)
                    .permitAll()
                    .requestMatchers("/healthz", "/readyz")
                    .permitAll()
                    .requestMatchers("/oauth2/**", "/login/oauth2/**")
                    .permitAll()
                    .requestMatchers(HttpMethod.GET, "/api/v1/session")
                    .permitAll()
                    .requestMatchers(
                        "/v3/api-docs", "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html")
                    .permitAll()
                    .requestMatchers("/api/v1/admin/**")
                    .hasRole("ADMIN")
                    .requestMatchers("/api/**")
                    .authenticated()
                    .anyRequest()
                    .denyAll())
        .oauth2Login(
            login ->
                login
                    .authorizationEndpoint(a -> a.authorizationRequestResolver(pkce(clients)))
                    .userInfoEndpoint(u -> u.oidcUserService(oidcUserService))
                    .defaultSuccessUrl("/", true)
                    .failureUrl("/?login=failed"))
        .oauth2ResourceServer(
            o ->
                o.jwt(j -> j.jwtAuthenticationConverter(jwtConverter))
                    .authenticationEntryPoint(
                        (req, res, ex) -> resolver.resolveException(req, res, null, ex))
                    .accessDeniedHandler(
                        (req, res, ex) -> resolver.resolveException(req, res, null, ex)))
        .logout(
            l ->
                l.logoutUrl("/api/v1/session/logout")
                    .logoutSuccessHandler(logoutSuccessHandler)
                    .deleteCookies("SESSION"))
        .exceptionHandling(
            e ->
                e.defaultAuthenticationEntryPointFor(
                        (req, res, ex) -> resolver.resolveException(req, res, null, ex),
                        SecurityConfig::isApi)
                    .accessDeniedHandler(
                        (req, res, ex) -> resolver.resolveException(req, res, null, ex)))
        // Before CSRF handling, and so before the OAuth2 login endpoints, which are served by
        // filters further down the chain: a request must be counted before anything answers it.
        .addFilterBefore(rateLimit, CsrfFilter.class)
        .addFilterBefore(bodyLimit, CsrfFilter.class);
    return http.build();
  }

  /** Signing in records the person (and refreshes their name and email) and maps their roles. */
  @Bean
  OAuth2UserService<OidcUserRequest, OidcUser> oidcUserService(UserDirectory users) {
    OidcUserService delegate = new OidcUserService();
    return request -> {
      OidcUser loaded = delegate.loadUser(request);
      UUID id = UUID.fromString(Objects.requireNonNull(loaded.getSubject()));
      users.recordLogin(
          id,
          loaded.getEmail(),
          displayName(loaded.getFullName(), loaded.getPreferredUsername(), loaded.getSubject()));
      var authorities = Roles.fromClaim(loaded.getClaimAsStringList("roles"));
      return new DefaultOidcUser(authorities, loaded.getIdToken(), loaded.getUserInfo());
    };
  }

  /**
   * Bearer tokens map the same {@code roles} claim; an unknown caller is recorded on first sight.
   */
  @Bean
  Converter<Jwt, AbstractAuthenticationToken> jwtConverter(UserDirectory users) {
    return jwt -> {
      UUID id = UUID.fromString(Objects.requireNonNull(jwt.getSubject()));
      users.ensureExists(
          id,
          jwt.getClaimAsString("email"),
          displayName(
              jwt.getClaimAsString("name"),
              jwt.getClaimAsString("preferred_username"),
              id.toString()));
      return new JwtAuthenticationToken(
          jwt, Roles.fromClaim(jwt.getClaimAsStringList("roles")), jwt.getSubject());
    };
  }

  /**
   * Verifies signature, expiry, issuer and audience of bearer tokens. The provider is contacted on
   * the first token, not at startup, so the API can boot (and stay up) while the identity provider
   * restarts. A token minted for another client of the same realm is refused by the audience rule.
   */
  @Bean
  JwtDecoder jwtDecoder(
      @Value("${spring.security.oauth2.client.provider.keycloak.issuer-uri}") String issuer,
      @Value("${app.security.audience:system-api}") String audience) {
    return new SupplierJwtDecoder(
        () -> {
          NimbusJwtDecoder decoder = NimbusJwtDecoder.withIssuerLocation(issuer).build();
          decoder.setJwtValidator(AudienceValidator.forIssuer(issuer, audience));
          return decoder;
        });
  }

  /**
   * Logout answers JSON naming the identity provider's end-session URL; the SPA navigates there.
   */
  @Bean
  LogoutSuccessHandler logoutSuccessHandler(
      ClientRegistrationRepository registrations, JsonMapper json) {
    return new JsonOidcLogoutSuccessHandler(registrations, json);
  }

  /**
   * PKCE on top of the client secret: a stolen authorization code is useless without the verifier.
   */
  private static OAuth2AuthorizationRequestResolver pkce(ClientRegistrationRepository clients) {
    var resolver = new DefaultOAuth2AuthorizationRequestResolver(clients, "/oauth2/authorization");
    resolver.setAuthorizationRequestCustomizer(OAuth2AuthorizationRequestCustomizers.withPkce());
    return resolver;
  }

  private static boolean isApi(HttpServletRequest request) {
    return request.getRequestURI().startsWith("/api/");
  }

  private static boolean carriesBearerToken(HttpServletRequest request) {
    String header = request.getHeader(HttpHeaders.AUTHORIZATION);
    return header != null && header.regionMatches(true, 0, "Bearer ", 0, "Bearer ".length());
  }

  /** The one route that accepts a large body: a file upload to a task. */
  private static boolean isUpload(HttpServletRequest request) {
    return "POST".equals(request.getMethod())
        && request.getRequestURI().matches("/api/v1/tasks/[0-9a-fA-F-]{36}/attachments");
  }

  private static String displayName(
      @Nullable String name, @Nullable String username, @Nullable String fallback) {
    for (String candidate : new String[] {name, username, fallback}) {
      if (candidate != null && !candidate.isBlank()) {
        return candidate;
      }
    }
    return "unknown";
  }
}
