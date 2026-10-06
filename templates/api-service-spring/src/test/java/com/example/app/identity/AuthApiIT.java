package com.example.app.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.AccountRepository;
import com.example.app.support.IntegrationTest;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.assertj.MvcTestResult;

class AuthApiIT extends IntegrationTest {

  @Autowired AccountRepository accounts;
  @Autowired JdbcTemplate jdbc;

  @Test
  void registerThenLoginThenMe() {
    String email = uniqueEmail().toUpperCase();

    MvcTestResult registered =
        post("/api/v1/auth/register", null, Map.of("email", email, "password", PASSWORD));
    assertThat(registered).hasStatus(HttpStatus.CREATED);
    assertThat(body(registered).path("email").asString()).isEqualTo(email.toLowerCase());
    assertThat(text(registered)).doesNotContain("password", "hash");

    MvcTestResult login =
        post("/api/v1/auth/login", null, Map.of("email", email, "password", PASSWORD));
    assertThat(login).hasStatus(HttpStatus.OK);
    assertThat(body(login).path("token_type").asString()).isEqualTo("Bearer");
    assertThat(body(login).path("expires_in").asInt()).isEqualTo(900);

    MvcTestResult me = get("/api/v1/auth/me", body(login).path("access_token").asString());
    assertThat(me).hasStatus(HttpStatus.OK);
    assertThat(body(me).path("email").asString()).isEqualTo(email.toLowerCase());
    assertThat(body(me).path("id").asString()).isEqualTo(body(registered).path("id").asString());
    assertThat(body(me).has("created_at")).isTrue();
    assertThat(body(me).has("createdAt")).isFalse();
  }

  @Test
  void anAccountWithNoLocalPasswordCanNeverLogIn() {
    // The shape of an account created from an OIDC token: the sentinel is not a hash of anything.
    String email = uniqueEmail();
    accounts.insert(
        Account.provisioned(
            UUID.randomUUID(), email, Instant.now().truncatedTo(ChronoUnit.MICROS)));

    for (String guess : List.of(PASSWORD, Account.NO_LOCAL_PASSWORD, "", "!", "$2a$12$x")) {
      MvcTestResult result =
          post("/api/v1/auth/login", null, Map.of("email", email, "password", guess));
      assertThat(result.getResponse().getStatus()).as(guess).isIn(400, 401);
    }
    assertProblem(
        post("/api/v1/auth/login", null, Map.of("email", email, "password", PASSWORD)),
        HttpStatus.UNAUTHORIZED,
        "invalid_credentials");
  }

  @Test
  void aSwitchedOffAccountCannotLogInEvenWithTheRightPassword() {
    String email = uniqueEmail();
    tokenFor(email);
    jdbc.update("update accounts set is_active = false where email = ?", email);

    assertProblem(
        post("/api/v1/auth/login", null, Map.of("email", email, "password", PASSWORD)),
        HttpStatus.UNAUTHORIZED,
        "invalid_credentials");
  }

  @Test
  void registeringTheSameEmailTwiceIsAConflictEvenWithDifferentCase() {
    String email = uniqueEmail();
    assertThat(post("/api/v1/auth/register", null, Map.of("email", email, "password", PASSWORD)))
        .hasStatus(HttpStatus.CREATED);

    MvcTestResult again =
        post(
            "/api/v1/auth/register",
            null,
            Map.of("email", email.toUpperCase(), "password", PASSWORD));

    assertProblem(again, HttpStatus.CONFLICT, "email_taken");
  }

  @Test
  void aWeakPasswordIsRejectedWithTheFieldNamed() {
    MvcTestResult result =
        post("/api/v1/auth/register", null, Map.of("email", uniqueEmail(), "password", "short"));

    assertProblem(result, HttpStatus.BAD_REQUEST, "validation_failed");
    assertThat(body(result).path("errors").get(0).path("field").asString()).isEqualTo("password");
  }

  @Test
  void aBadEmailIsRejected() {
    assertThat(post("/api/v1/auth/register", null, Map.of("email", "nope", "password", PASSWORD)))
        .hasStatus(HttpStatus.BAD_REQUEST);
  }

  @Test
  void aWrongPasswordAndAnUnknownEmailGetTheSameAnswer() {
    String email = uniqueEmail();
    tokenFor(email);

    MvcTestResult wrong =
        post("/api/v1/auth/login", null, Map.of("email", email, "password", "not the password!!"));
    MvcTestResult unknown =
        post("/api/v1/auth/login", null, Map.of("email", uniqueEmail(), "password", PASSWORD));

    assertProblem(wrong, HttpStatus.UNAUTHORIZED, "invalid_credentials");
    assertProblem(unknown, HttpStatus.UNAUTHORIZED, "invalid_credentials");
    assertThat(body(wrong).path("detail").asString())
        .isEqualTo(body(unknown).path("detail").asString());
  }

  @Test
  void aMissingPasswordFieldIsABadRequest() {
    assertThat(post("/api/v1/auth/login", null, Map.of("email", uniqueEmail())))
        .hasStatus(HttpStatus.BAD_REQUEST);
  }
}
