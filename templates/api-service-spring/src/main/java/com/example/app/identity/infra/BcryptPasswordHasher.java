package com.example.app.identity.infra;

import com.example.app.identity.domain.PasswordHasher;
import com.example.app.shared.config.AppProperties;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * bcrypt at a configurable cost (default 12; OWASP's floor is 10). bcrypt needs no extra dependency
 * and is on OWASP's accepted list; Argon2id is preferred where a library is acceptable, see {@code
 * .aico/decisions.md} for why this starter does not add one. Hashes carry their own cost, so
 * raising {@code APP_BCRYPT_COST} upgrades each account on its next login.
 */
@Component
class BcryptPasswordHasher implements PasswordHasher {

  private final BCryptPasswordEncoder encoder;

  BcryptPasswordHasher(AppProperties props) {
    this.encoder = new BCryptPasswordEncoder(props.security().bcryptCost());
  }

  @Override
  public String hash(String rawPassword) {
    return encoder.encode(rawPassword);
  }

  @Override
  public boolean matches(String rawPassword, String hash) {
    return encoder.matches(rawPassword, hash);
  }

  @Override
  public boolean needsRehash(String hash) {
    return encoder.upgradeEncoding(hash);
  }
}
