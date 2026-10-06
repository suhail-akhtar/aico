package com.example.app.shared.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.example.app.shared.error.AccountDisabledException;
import jakarta.servlet.FilterChain;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.servlet.HandlerExceptionResolver;

/** The step between "token verified" and "controller runs", without a server. */
class CallerProvisioningFilterTest {

  private final CallerProvisioner provisioner = mock(CallerProvisioner.class);
  private final HandlerExceptionResolver resolver = mock(HandlerExceptionResolver.class);
  private final FilterChain chain = mock(FilterChain.class);
  private final CallerProvisioningFilter filter =
      new CallerProvisioningFilter(provisioner, resolver);

  @AfterEach
  void clearContext() {
    SecurityContextHolder.clearContext();
  }

  private static JwtAuthenticationToken authenticated(UUID sub, String email) {
    Jwt.Builder jwt =
        Jwt.withTokenValue("t")
            .header("alg", "RS256")
            .subject(sub.toString())
            .issuedAt(Instant.now())
            .expiresAt(Instant.now().plusSeconds(60));
    if (email != null) {
      jwt.claim("email", email);
    }
    return new JwtAuthenticationToken(jwt.build());
  }

  @Test
  void aVerifiedCallerIsProvisionedWithItsSubjectAndEmailThenTheRequestContinues()
      throws Exception {
    UUID sub = UUID.randomUUID();
    SecurityContextHolder.getContext().setAuthentication(authenticated(sub, "a@example.com"));
    var request = new MockHttpServletRequest("GET", "/api/v1/items");
    var response = new MockHttpServletResponse();

    filter.doFilter(request, response, chain);

    verify(provisioner).ensureKnown(sub, "a@example.com");
    verify(chain).doFilter(any(), any());
  }

  @Test
  void aTokenWithoutAnEmailClaimPassesNull() throws Exception {
    UUID sub = UUID.randomUUID();
    SecurityContextHolder.getContext().setAuthentication(authenticated(sub, null));

    filter.doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), chain);

    verify(provisioner).ensureKnown(sub, null);
  }

  @Test
  void anAnonymousRequestIsPassedOnUntouched() throws Exception {
    filter.doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), chain);

    verify(provisioner, never()).ensureKnown(any(), any());
    verify(chain).doFilter(any(), any());
  }

  @Test
  void aNonJwtAuthenticationIsIgnored() throws Exception {
    SecurityContextHolder.getContext()
        .setAuthentication(
            UsernamePasswordAuthenticationToken.authenticated("u", "p", java.util.List.of()));

    filter.doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), chain);

    verify(provisioner, never()).ensureKnown(any(), any());
    verify(chain).doFilter(any(), any());
  }

  @Test
  void aRefusalStopsTheChainAndGoesThroughTheProblemResolver() throws Exception {
    UUID sub = UUID.randomUUID();
    SecurityContextHolder.getContext().setAuthentication(authenticated(sub, "a@example.com"));
    doThrow(new AccountDisabledException()).when(provisioner).ensureKnown(sub, "a@example.com");

    filter.doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), chain);

    ArgumentCaptor<Exception> thrown = ArgumentCaptor.forClass(Exception.class);
    verify(resolver).resolveException(any(), any(), isNull(), thrown.capture());
    assertThat(thrown.getValue()).isInstanceOf(AccountDisabledException.class);
    verify(chain, never()).doFilter(any(), any());
  }

  @Test
  void anUnexpectedFailureAlsoGoesThroughTheResolverInsteadOfEscapingTheFilter() throws Exception {
    UUID sub = UUID.randomUUID();
    SecurityContextHolder.getContext().setAuthentication(authenticated(sub, null));
    doThrow(new IllegalStateException("database down")).when(provisioner).ensureKnown(sub, null);

    filter.doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), chain);

    verify(resolver).resolveException(any(), any(), isNull(), any(IllegalStateException.class));
    verify(chain, never()).doFilter(any(), any());
  }
}
