package com.example.app.shared.security;

import com.example.app.shared.config.AppProperties;
import com.example.app.shared.web.BodySizeLimitFilter;
import com.example.app.shared.web.RateLimitFilter;
import com.example.app.shared.web.RateLimiter;
import jakarta.servlet.DispatcherType;
import java.time.Clock;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimNames;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.header.writers.CrossOriginOpenerPolicyHeaderWriter;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.servlet.HandlerExceptionResolver;

/**
 * Stateless bearer-token security. Every route needs a valid JWT except health, registration, login
 * and the API documents. Defaults are deny: a route is public only by being listed here. Which
 * tokens are valid depends on {@code APP_AUTH_MODE}: the ones this service issues (local) or the
 * ones an external OIDC provider issues (oidc); everything else in the chain is the same.
 *
 * <p>CSRF protection is off on purpose: the API keeps no session and reads no cookies, so a forged
 * cross-site request carries no credentials to abuse. Add it back if you ever authenticate with
 * cookies.
 */
@Configuration(proxyBeanMethods = false)
@EnableWebSecurity
class SecurityConfig {

  private static final String CSP = "default-src 'none'; frame-ancestors 'none'";

  @Bean
  SecurityFilterChain securityFilterChain(
      HttpSecurity http,
      AppProperties props,
      Clock clock,
      @Qualifier("corsConfigurationSource") CorsConfigurationSource corsSource,
      @Qualifier("handlerExceptionResolver") HandlerExceptionResolver resolver,
      ObjectProvider<CallerProvisioner> provisioner)
      throws Exception {
    AppProperties.RateLimit rl = props.rateLimit();
    var bodyLimit = new BodySizeLimitFilter(props.http().maxBodySize().toBytes(), resolver);
    var rateLimit =
        new RateLimitFilter(
            new RateLimiter(rl.capacity(), rl.refillPerMinute(), clock),
            new RateLimiter(rl.authCapacity(), rl.authRefillPerMinute(), clock),
            resolver);

    http.csrf(AbstractHttpConfigurer::disable)
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .cors(c -> c.configurationSource(corsSource))
        .headers(
            h ->
                h.httpStrictTransportSecurity(
                        hsts ->
                            hsts.includeSubDomains(true).preload(true).maxAgeInSeconds(63_072_000))
                    .referrerPolicy(
                        r -> r.policy(ReferrerPolicyHeaderWriter.ReferrerPolicy.NO_REFERRER))
                    .crossOriginOpenerPolicy(
                        c ->
                            c.policy(
                                CrossOriginOpenerPolicyHeaderWriter.CrossOriginOpenerPolicy
                                    .SAME_ORIGIN))
                    .addHeaderWriter(
                        (request, response) -> {
                          // The Swagger UI page needs scripts and styles; the JSON API does not.
                          if (!request.getRequestURI().startsWith("/swagger-ui")) {
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
                    .requestMatchers(HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login")
                    .permitAll()
                    .requestMatchers(
                        "/v3/api-docs", "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html")
                    .permitAll()
                    .anyRequest()
                    .authenticated())
        .oauth2ResourceServer(
            o ->
                o.jwt(Customizer.withDefaults())
                    .authenticationEntryPoint(
                        (req, res, ex) -> resolver.resolveException(req, res, null, ex))
                    .accessDeniedHandler(
                        (req, res, ex) -> resolver.resolveException(req, res, null, ex)))
        .exceptionHandling(
            e ->
                e.authenticationEntryPoint(
                        (req, res, ex) -> resolver.resolveException(req, res, null, ex))
                    .accessDeniedHandler(
                        (req, res, ex) -> resolver.resolveException(req, res, null, ex)))
        .addFilterBefore(bodyLimit, BearerTokenAuthenticationFilter.class)
        .addFilterBefore(rateLimit, BearerTokenAuthenticationFilter.class);
    if (props.auth().oidcEnabled()) {
      // After the token is verified, before any controller: the caller gets an account row (first
      // sight of a subject) or is refused (switched off, email owned by another account).
      http.addFilterAfter(
          new CallerProvisioningFilter(provisioner.getObject(), resolver),
          BearerTokenAuthenticationFilter.class);
    }
    return http.build();
  }

  /**
   * Local mode: verifies the HS256 tokens this service issued (signature, expiry, issuer and
   * audience); a token for another service is refused.
   */
  @Bean
  @ConditionalOnProperty(
      prefix = "app.auth",
      name = "mode",
      havingValue = "local",
      matchIfMissing = true)
  JwtDecoder jwtDecoder(AppProperties props) {
    AppProperties.Jwt jwt = props.jwt();
    NimbusJwtDecoder decoder =
        NimbusJwtDecoder.withSecretKey(JwtKeys.secretKey(jwt))
            .macAlgorithm(MacAlgorithm.HS256)
            .build();
    OAuth2TokenValidator<Jwt> audience =
        new JwtClaimValidator<List<String>>(
            JwtClaimNames.AUD, aud -> aud != null && aud.contains(jwt.audience()));
    decoder.setJwtValidator(
        new DelegatingOAuth2TokenValidator<>(
            JwtValidators.createDefaultWithIssuer(jwt.issuer()), audience));
    return decoder;
  }

  /** OIDC mode: verifies RS256 access tokens from the configured provider; see the factory. */
  @Bean
  @ConditionalOnProperty(prefix = "app.auth", name = "mode", havingValue = "oidc")
  JwtDecoder oidcJwtDecoder(AppProperties props) {
    return OidcJwtDecoders.create(props.auth().oidc());
  }

  /** Explicit allow-list from configuration. With no origins configured, nothing is allowed. */
  @Bean
  CorsConfigurationSource corsConfigurationSource(AppProperties props) {
    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    List<String> origins =
        props.cors().allowedOrigins().stream().filter(o -> !o.isBlank()).toList();
    if (!origins.isEmpty()) {
      CorsConfiguration config = new CorsConfiguration();
      config.setAllowedOrigins(origins);
      config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
      config.setAllowedHeaders(
          List.of(HttpHeaders.AUTHORIZATION, HttpHeaders.CONTENT_TYPE, "X-Request-Id"));
      config.setExposedHeaders(
          List.of("X-Request-Id", HttpHeaders.RETRY_AFTER, HttpHeaders.LOCATION));
      config.setAllowCredentials(false);
      config.setMaxAge(3600L);
      source.registerCorsConfiguration("/**", config);
    }
    return source;
  }
}
