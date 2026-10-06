package com.example.app.identity.infra;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.app.identity.domain.Account;
import com.example.app.shared.error.LocalAuthDisabledException;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class DisabledTokenIssuerTest {

  @Test
  void itNeverMintsAToken() {
    var issuer = new DisabledTokenIssuer();

    assertThatThrownBy(
            () -> issuer.issue(new Account(UUID.randomUUID(), "a@b.co", "x", Instant.now())))
        .isInstanceOf(LocalAuthDisabledException.class);
  }
}
