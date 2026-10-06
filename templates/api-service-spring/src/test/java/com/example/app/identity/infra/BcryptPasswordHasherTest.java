package com.example.app.identity.infra;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.app.shared.config.AppProperties;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.util.unit.DataSize;

/**
 * Pins the password-hashing parameters. If someone lowers the work factor, this fails; OWASP's
 * floor for bcrypt is cost 10 and this starter defaults to 12.
 */
class BcryptPasswordHasherTest {

  private static BcryptPasswordHasher hasher(int cost) {
    return new BcryptPasswordHasher(
        new AppProperties(
            new AppProperties.Auth(
                AppProperties.Auth.Mode.LOCAL,
                new AppProperties.Oidc(
                    null, null, null, Duration.ofSeconds(30), Duration.ofSeconds(30))),
            new AppProperties.Jwt(
                "0123456789abcdef0123456789abcdef", "i", "a", Duration.ofMinutes(5)),
            new AppProperties.Security(cost),
            new AppProperties.Cors(List.of()),
            new AppProperties.RateLimit(1, 1, 1, 1),
            new AppProperties.Http(DataSize.ofKilobytes(1))));
  }

  @Test
  void hashesAtTheConfiguredCostWithAPerPasswordSalt() {
    var hasher = hasher(12);

    String first = hasher.hash("a long enough password");
    String second = hasher.hash("a long enough password");

    assertThat(first).startsWith("$2a$12$").isNotEqualTo(second);
    assertThat(hasher.matches("a long enough password", first)).isTrue();
    assertThat(hasher.matches("another password", first)).isFalse();
  }

  @Test
  void aHashMadeWithALowerCostNeedsARehash() {
    String old = new BCryptPasswordEncoder(10).encode("a long enough password");

    assertThat(hasher(12).needsRehash(old)).isTrue();
    assertThat(hasher(12).needsRehash(hasher(12).hash("x".repeat(12)))).isFalse();
  }
}
