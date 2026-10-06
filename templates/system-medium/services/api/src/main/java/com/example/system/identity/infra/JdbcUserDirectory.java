package com.example.system.identity.infra;

import com.example.system.identity.domain.UserDirectory;
import java.time.Clock;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Adapter: implements {@link UserDirectory} with two single-statement upserts, so two concurrent
 * first sign-ins of the same person cannot race into a unique-key error.
 */
@Repository
class JdbcUserDirectory implements UserDirectory {

  private static final int DISPLAY_NAME_MAX = 200;
  private static final int EMAIL_MAX = 254;

  private final JdbcClient jdbc;
  private final Clock clock;

  JdbcUserDirectory(JdbcClient jdbc, Clock clock) {
    this.jdbc = jdbc;
    this.clock = clock;
  }

  @Override
  @Transactional
  public void recordLogin(UUID id, @Nullable String email, String displayName) {
    jdbc.sql(
            """
            insert into users (id, email, display_name, created_at, last_login_at, version)
            values (:id, :email, :name, :now, :now, 0)
            on conflict (id) do update
              set email = excluded.email,
                  display_name = excluded.display_name,
                  last_login_at = excluded.last_login_at,
                  version = users.version + 1
            """)
        .param("id", id)
        .param("email", clip(email, EMAIL_MAX))
        .param("name", clip(displayName, DISPLAY_NAME_MAX))
        .param("now", java.sql.Timestamp.from(clock.instant()))
        .update();
  }

  @Override
  @Transactional
  public void ensureExists(UUID id, @Nullable String email, String displayName) {
    jdbc.sql(
            """
            insert into users (id, email, display_name, created_at, last_login_at, version)
            values (:id, :email, :name, :now, :now, 0)
            on conflict (id) do nothing
            """)
        .param("id", id)
        .param("email", clip(email, EMAIL_MAX))
        .param("name", clip(displayName, DISPLAY_NAME_MAX))
        .param("now", java.sql.Timestamp.from(clock.instant()))
        .update();
  }

  private static @Nullable String clip(@Nullable String value, int max) {
    if (value == null) {
      return null;
    }
    return value.length() <= max ? value : value.substring(0, max);
  }
}
