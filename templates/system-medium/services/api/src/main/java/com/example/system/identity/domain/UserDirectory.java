package com.example.system.identity.domain;

import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Port: the application's own record of the people the identity provider has vouched for. The
 * provider is the source of truth for who someone is; this table exists so other tables can point
 * at a user with a real foreign key and so an admin screen can show a name. Nothing here holds a
 * credential.
 */
public interface UserDirectory {

  /** Interactive sign-in: create the user or refresh their email, name and last-login time. */
  void recordLogin(UUID id, @Nullable String email, String displayName);

  /** Bearer-token call: make sure the user exists, writing nothing if they already do. */
  void ensureExists(UUID id, @Nullable String email, String displayName);
}
