package com.example.system.support;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.oidcLogin;

import com.example.system.identity.domain.UserDirectory;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.assertj.MockMvcTester;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Base for tests that boot the whole application over real PostgreSQL and Valkey (see {@link
 * TestInfrastructure}) with the identity provider, SMTP and object storage replaced by fakes (see
 * {@link TestBeans}). It offers the helpers every API test needs: make a signed-in caller (a
 * browser session or a bearer token), call an endpoint as that caller, and assert an RFC 9457
 * problem. Every test makes its own callers, so tests share one database without sharing data.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(TestBeans.class)
public abstract class IntegrationTest {

  @Autowired protected MockMvcTester mvc;
  @Autowired protected JsonMapper json;
  @Autowired protected RecordingMailSender mails;
  @Autowired protected InMemoryObjectStore store;
  @Autowired private UserDirectory users;

  @DynamicPropertySource
  static void infrastructure(DynamicPropertyRegistry registry) {
    TestInfrastructure.register(registry);
  }

  /** A person known to the identity provider: the subject, an address, and their roles. */
  public record Caller(UUID id, String email, List<String> roles) {

    /** A browser session: what the cookie-backed login produces after a sign-in. */
    public RequestPostProcessor session() {
      var authorities = roles.stream().map(r -> new SimpleGrantedAuthority("ROLE_" + r)).toList();
      return oidcLogin()
          .idToken(t -> t.subject(id.toString()).claim("email", email).claim("name", email))
          .authorities(authorities.toArray(new SimpleGrantedAuthority[0]));
    }

    /** A machine client presenting a bearer token. */
    public RequestPostProcessor bearer() {
      var authorities = roles.stream().map(r -> new SimpleGrantedAuthority("ROLE_" + r)).toList();
      return jwt()
          .jwt(j -> j.subject(id.toString()).claim("email", email).claim("roles", roles))
          .authorities(authorities.toArray(new SimpleGrantedAuthority[0]));
    }
  }

  /** A new, unique member, recorded in the user directory as a first sign-in would. */
  protected Caller newMember() {
    return newCaller("MEMBER");
  }

  protected Caller newAdmin() {
    return newCaller("MEMBER", "ADMIN");
  }

  protected Caller newCaller(String... roles) {
    UUID id = UUID.randomUUID();
    String email = "user-" + id + "@example.com";
    users.recordLogin(id, email, email);
    return new Caller(id, email, List.of(roles));
  }

  protected MvcTestResult get(String path, Caller as) {
    var request = mvc.get().uri(URI.create(path));
    return (as == null ? request : request.with(as.session())).exchange();
  }

  protected MvcTestResult post(String path, Caller as, Object body) {
    return write(mvc.post().uri(URI.create(path)), as, body);
  }

  protected MvcTestResult put(String path, Caller as, Object body) {
    return write(mvc.put().uri(URI.create(path)), as, body);
  }

  protected MvcTestResult delete(String path, Caller as) {
    return write(mvc.delete().uri(URI.create(path)), as, null);
  }

  private MvcTestResult write(MockMvcTester.MockMvcRequestBuilder builder, Caller as, Object body) {
    if (as != null) {
      builder.with(as.session()).with(csrf());
    }
    if (body != null) {
      builder.contentType(MediaType.APPLICATION_JSON);
      builder.content(body instanceof String s ? s : json.writeValueAsString(body));
    }
    return builder.exchange();
  }

  protected JsonNode body(MvcTestResult result) {
    return json.readTree(text(result));
  }

  protected String text(MvcTestResult result) {
    try {
      return result.getResponse().getContentAsString();
    } catch (java.io.UnsupportedEncodingException e) {
      throw new IllegalStateException(e);
    }
  }

  /** Creates a task as the caller and returns its id. */
  protected String createTask(Caller as, String title) {
    MvcTestResult result = post("/api/v1/tasks", as, Map.of("title", title));
    assertThat(result).hasStatus(HttpStatus.CREATED);
    return body(result).path("id").asString();
  }

  /** Asserts an application/problem+json response with the given status and code. */
  protected void assertProblem(MvcTestResult result, HttpStatus status, String code) {
    assertThat(result)
        .hasStatus(status)
        .hasContentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON)
        .bodyJson()
        .extractingPath("$.code")
        .isEqualTo(code);
    JsonNode problem = body(result);
    assertThat(problem.path("status").asInt()).isEqualTo(status.value());
    assertThat(problem.path("type").asString()).startsWith("urn:problem-type:");
    // Nothing internal may leak into an error body.
    assertThat(problem.toString())
        .doesNotContain("Exception", "at com.", "org.springframework", "org.hibernate", "SQL");
  }
}
