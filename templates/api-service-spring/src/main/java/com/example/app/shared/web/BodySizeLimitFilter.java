package com.example.app.shared.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerExceptionResolver;

/**
 * Rejects oversized bodies. A declared {@code Content-Length} over the limit is refused before a
 * byte is read; a chunked body (no length) is counted as it streams and cut off at the limit.
 * Tomcat only limits form posts, so without this a JSON endpoint would buffer whatever it is sent.
 */
public class BodySizeLimitFilter extends OncePerRequestFilter {

  private final long maxBytes;
  private final HandlerExceptionResolver resolver;

  public BodySizeLimitFilter(long maxBytes, HandlerExceptionResolver resolver) {
    this.maxBytes = maxBytes;
    this.resolver = resolver;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    long declared = request.getContentLengthLong();
    if (declared > maxBytes) {
      resolver.resolveException(request, response, null, new PayloadTooLargeException(maxBytes));
      return;
    }
    chain.doFilter(declared < 0 ? new LimitedRequest(request, maxBytes) : request, response);
  }

  /** Counts bytes read from a body whose size was not declared. */
  private static final class LimitedRequest extends HttpServletRequestWrapper {

    private final long maxBytes;

    LimitedRequest(HttpServletRequest request, long maxBytes) {
      super(request);
      this.maxBytes = maxBytes;
    }

    @Override
    public ServletInputStream getInputStream() throws IOException {
      return new LimitedStream(super.getInputStream(), maxBytes);
    }

    @Override
    public BufferedReader getReader() throws IOException {
      String name = getCharacterEncoding();
      Charset charset = name == null ? StandardCharsets.UTF_8 : Charset.forName(name);
      return new BufferedReader(new InputStreamReader(getInputStream(), charset));
    }
  }

  private static final class LimitedStream extends ServletInputStream {

    private final ServletInputStream delegate;
    private final long maxBytes;
    private long count;

    LimitedStream(ServletInputStream delegate, long maxBytes) {
      this.delegate = delegate;
      this.maxBytes = maxBytes;
    }

    @Override
    public int read() throws IOException {
      int b = delegate.read();
      if (b >= 0) {
        count(1);
      }
      return b;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      int n = delegate.read(buffer, offset, length);
      if (n > 0) {
        count(n);
      }
      return n;
    }

    private void count(int n) throws IOException {
      count += n;
      if (count > maxBytes) {
        throw new PayloadTooLargeException(maxBytes);
      }
    }

    @Override
    public boolean isFinished() {
      return delegate.isFinished();
    }

    @Override
    public boolean isReady() {
      return delegate.isReady();
    }

    @Override
    public void setReadListener(ReadListener listener) {
      delegate.setReadListener(listener);
    }
  }
}
