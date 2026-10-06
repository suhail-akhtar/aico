package com.example.app.identity.domain;

/** Port: one-way password hashing, so the algorithm can change without touching the use cases. */
public interface PasswordHasher {

  String hash(String rawPassword);

  boolean matches(String rawPassword, String hash);

  /** True when the stored hash was made with weaker settings than the current ones. */
  boolean needsRehash(String hash);
}
