package com.example.system.shared.page;

/** A page request that the domain can use without importing Spring Data. */
public record PageQuery(int page, int size) {

  public static final int MAX_SIZE = 100;

  public PageQuery {
    if (page < 0) {
      throw new IllegalArgumentException("page must be >= 0");
    }
    if (size < 1 || size > MAX_SIZE) {
      throw new IllegalArgumentException("size must be between 1 and " + MAX_SIZE);
    }
  }
}
