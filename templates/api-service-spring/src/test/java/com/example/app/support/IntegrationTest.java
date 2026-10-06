package com.example.app.support;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.assertj.MockMvcTester;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Base for tests that boot the whole application over a real database (see {@link TestDatabase}).
 * It exposes the helpers every API test needs: sign up a throwaway user, call an endpoint with a
 * token, and assert an RFC 9457 problem. Every test makes its own users, so tests share one
 * database without sharing data.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
public abstract class IntegrationTest {

  /** Not a real password; long enough for the policy. */
  protected static final String PASSWORD = "correct horse battery staple";

  @Autowired protected MockMvcTester mvc;
  @Autowired protected JsonMapper json;

  @DynamicPropertySource
  static void database(DynamicPropertyRegistry registry) {
    TestDatabase.register(registry);
  }

  protected String uniqueEmail() {
    return "user-" + UUID.randomUUID() + "@example.com";
  }

  /** Registers a new user and returns a bearer token for it. */
  protected String newUserToken() {
    return tokenFor(uniqueEmail());
  }

  protected String tokenFor(String email) {
    assertThat(post("/api/v1/auth/register", null, Map.of("email", email, "password", PASSWORD)))
        .hasStatus(HttpStatus.CREATED);
    return login(email, PASSWORD);
  }

  protected String login(String email, String password) {
    MvcTestResult result =
        post("/api/v1/auth/login", null, Map.of("email", email, "password", password));
    assertThat(result).hasStatus(HttpStatus.OK);
    return body(result).path("access_token").asString();
  }

  protected MvcTestResult post(String path, String token, Object body) {
    return send(mvc.post().uri(URI.create(path)), token, body);
  }

  protected MvcTestResult put(String path, String token, Object body) {
    return send(mvc.put().uri(URI.create(path)), token, body);
  }

  protected MvcTestResult get(String path, String token) {
    return send(mvc.get().uri(URI.create(path)), token, null);
  }

  protected MvcTestResult delete(String path, String token) {
    return send(mvc.delete().uri(URI.create(path)), token, null);
  }

  private MvcTestResult send(
      org.springframework.test.web.servlet.assertj.MockMvcTester.MockMvcRequestBuilder builder,
      String token,
      Object body) {
    if (token != null) {
      builder.header(HttpHeaders.AUTHORIZATION, "Bearer " + token);
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

  /** Creates an item as the token's owner and returns its id. */
  protected String createItem(String token, String name) {
    MvcTestResult result = post("/api/v1/items", token, Map.of("name", name));
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
