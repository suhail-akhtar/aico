package com.example.app.shared.page;

import org.jspecify.annotations.Nullable;

/**
 * A request for one page that the domain can use without importing Spring Data: how many rows, and
 * where to start (after the row a {@link Cursor} names, or from the newest when there is none).
 */
public record PageQuery(int limit, @Nullable Cursor after) {

  public static final int DEFAULT_LIMIT = 50;
  public static final int MAX_LIMIT = 100;

  public PageQuery {
    if (limit < 1 || limit > MAX_LIMIT) {
      throw new IllegalArgumentException("limit must be between 1 and " + MAX_LIMIT);
    }
  }

  /** The first page of the default size. */
  public static PageQuery first() {
    return new PageQuery(DEFAULT_LIMIT, null);
  }
}
