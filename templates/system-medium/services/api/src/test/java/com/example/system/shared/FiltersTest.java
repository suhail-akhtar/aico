package com.example.system.shared;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.example.system.shared.error.RateLimitExceededException;
import com.example.system.shared.web.BodySizeLimitFilter;
import com.example.system.shared.web.InMemoryRateLimiter;
import com.example.system.shared.web.PayloadTooLargeException;
import com.example.system.shared.web.RateLimitFilter;
import com.example.system.shared.web.RequestIdFilter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.HandlerExceptionResolver;

/** The three servlet filters, exercised without a server. */
class FiltersTest {

  private final HandlerExceptionResolver resolver = mock(HandlerExceptionResolver.class);
  private final FilterChain chain = mock(FilterChain.class);

  /** A request that does not declare a length, like a chunked upload. */
  private static MockHttpServletRequest chunked(byte[] body) {
    MockHttpServletRequest request =
        new MockHttpServletRequest("POST", "/api/v1/tasks") {
          @Override
          public long getContentLengthLong() {
            return -1;
          }
        };
    request.setContent(body);
    request.setCharacterEncoding("UTF-8");
    return request;
  }

  @Test
  void bodyLimitRefusesADeclaredLengthOverTheLimitWithoutCallingTheChain() throws Exception {
    var filter = new BodySizeLimitFilter(10, resolver);
    var request = new MockHttpServletRequest("POST", "/x");
    request.setContent(new byte[11]);

    filter.doFilter(request, new MockHttpServletResponse(), chain);

    ArgumentCaptor<Exception> thrown = ArgumentCaptor.forClass(Exception.class);
    verify(resolver).resolveException(any(), any(), isNull(), thrown.capture());
    assertThat(thrown.getValue()).isInstanceOf(PayloadTooLargeException.class);
    verify(chain, never()).doFilter(any(), any());
  }

  @Test
  void bodyLimitUsesTheLargerCeilingOnlyOnTheUploadRoute() throws Exception {
    var filter =
        new BodySizeLimitFilter(10, 100, r -> r.getRequestURI().endsWith("/attachments"), resolver);
    var upload = new MockHttpServletRequest("POST", "/api/v1/tasks/x/attachments");
    upload.setContent(new byte[50]);
    var json = new MockHttpServletRequest("POST", "/api/v1/tasks");
    json.setContent(new byte[50]);

    filter.doFilter(upload, new MockHttpServletResponse(), chain);
    filter.doFilter(json, new MockHttpServletResponse(), chain);

    verify(chain).doFilter(any(), any());
    verify(resolver).resolveException(any(), any(), isNull(), any(PayloadTooLargeException.class));
  }

  @Test
  void bodyLimitLetsASmallBodyThrough() throws Exception {
    var filter = new BodySizeLimitFilter(10, resolver);
    var request = new MockHttpServletRequest("POST", "/x");
    request.setContent(new byte[10]);

    filter.doFilter(request, new MockHttpServletResponse(), chain);

    verify(chain).doFilter(any(), any());
  }

  @Test
  void bodyLimitCutsOffAChunkedBodyAsItStreams() throws Exception {
    var filter = new BodySizeLimitFilter(10, resolver);
    ArgumentCaptor<HttpServletRequest> wrapped = ArgumentCaptor.forClass(HttpServletRequest.class);

    filter.doFilter(chunked(new byte[50]), new MockHttpServletResponse(), chain);
    verify(chain).doFilter(wrapped.capture(), any());
    ServletInputStream in = wrapped.getValue().getInputStream();

    assertThatThrownBy(() -> in.readAllBytes()).isInstanceOf(PayloadTooLargeException.class);
  }

  @Test
  void bodyLimitAllowsAChunkedBodyUnderTheLimitInBothReadStyles() throws Exception {
    var filter = new BodySizeLimitFilter(10, resolver);
    ArgumentCaptor<HttpServletRequest> wrapped = ArgumentCaptor.forClass(HttpServletRequest.class);

    filter.doFilter(
        chunked("hello".getBytes(StandardCharsets.UTF_8)), new MockHttpServletResponse(), chain);
    verify(chain).doFilter(wrapped.capture(), any());
    HttpServletRequest request = wrapped.getValue();
    ServletInputStream in = request.getInputStream();

    assertThat(in.readAllBytes()).hasSize(5);
    assertThat(in.isFinished()).isTrue();
    assertThat(in.isReady()).isTrue();
    BufferedReader reader = request.getReader();
    assertThat(reader).isNotNull();
  }

  @Test
  void bodyLimitReaderOfAnOversizedChunkedBodyFails() throws Exception {
    var filter = new BodySizeLimitFilter(4, resolver);
    ArgumentCaptor<HttpServletRequest> wrapped = ArgumentCaptor.forClass(HttpServletRequest.class);

    filter.doFilter(
        chunked("hello world".getBytes(StandardCharsets.UTF_8)),
        new MockHttpServletResponse(),
        chain);
    verify(chain).doFilter(wrapped.capture(), any());
    BufferedReader reader = wrapped.getValue().getReader();

    assertThatThrownBy(() -> reader.readLine()).isInstanceOf(IOException.class);
  }

  @Test
  void rateLimitRefusesOnceTheBudgetIsSpentAndCarriesRetryAfter() throws Exception {
    var filter =
        new RateLimitFilter(
            new InMemoryRateLimiter(1, 60, Clock.systemUTC()),
            new InMemoryRateLimiter(1, 60, Clock.systemUTC()),
            resolver);
    var request = new MockHttpServletRequest("GET", "/api/v1/tasks");

    filter.doFilter(request, new MockHttpServletResponse(), chain);
    filter.doFilter(request, new MockHttpServletResponse(), chain);

    verify(chain).doFilter(any(), any());
    ArgumentCaptor<Exception> thrown = ArgumentCaptor.forClass(Exception.class);
    verify(resolver).resolveException(any(), any(), isNull(), thrown.capture());
    assertThat(thrown.getValue())
        .isInstanceOfSatisfying(
            RateLimitExceededException.class, e -> assertThat(e.retryAfterSeconds()).isPositive());
  }

  @Test
  void loginEndpointsUseTheirOwnSmallerBudget() throws Exception {
    var filter =
        new RateLimitFilter(
            new InMemoryRateLimiter(100, 6000, Clock.systemUTC()),
            new InMemoryRateLimiter(1, 1, Clock.systemUTC()),
            resolver);
    var login = new MockHttpServletRequest("GET", "/oauth2/authorization/keycloak");

    filter.doFilter(login, new MockHttpServletResponse(), chain);
    filter.doFilter(login, new MockHttpServletResponse(), chain);

    verify(resolver)
        .resolveException(any(), any(), isNull(), any(RateLimitExceededException.class));
  }

  @Test
  void healthProbesAreNeverRateLimited() throws Exception {
    var filter =
        new RateLimitFilter(
            new InMemoryRateLimiter(1, 1, Clock.systemUTC()),
            new InMemoryRateLimiter(1, 1, Clock.systemUTC()),
            resolver);

    for (int i = 0; i < 5; i++) {
      filter.doFilter(
          new MockHttpServletRequest("GET", "/healthz"), new MockHttpServletResponse(), chain);
    }

    verify(resolver, never()).resolveException(any(), any(), any(), any());
  }

  @Test
  void requestIdKeepsAPlainSuppliedIdAndEchoesIt() throws Exception {
    var request = new MockHttpServletRequest("GET", "/x");
    request.addHeader(RequestIdFilter.HEADER, "abc-123_DEF.4");
    var response = new MockHttpServletResponse();

    new RequestIdFilter().doFilter(request, response, chain);

    assertThat(response.getHeader(RequestIdFilter.HEADER)).isEqualTo("abc-123_DEF.4");
    assertThat(MDC.get(RequestIdFilter.MDC_KEY)).isNull();
  }

  @Test
  void requestIdReplacesAHostileSuppliedId() throws Exception {
    var request = new MockHttpServletRequest("GET", "/x");
    request.addHeader(RequestIdFilter.HEADER, "evil\nSet-Cookie: x=1");
    var response = new MockHttpServletResponse();

    new RequestIdFilter().doFilter(request, response, chain);

    assertThat(response.getHeader(RequestIdFilter.HEADER)).matches("[0-9a-f-]{36}");
  }

  @Test
  void requestIdIsInTheLoggingContextWhileTheRequestRuns() throws Exception {
    var response = new MockHttpServletResponse();
    String[] seen = new String[1];
    FilterChain inspecting = (req, res) -> seen[0] = MDC.get(RequestIdFilter.MDC_KEY);

    new RequestIdFilter().doFilter(new MockHttpServletRequest("GET", "/x"), response, inspecting);

    assertThat(seen[0]).isEqualTo(response.getHeader(RequestIdFilter.HEADER));
  }
}
