package com.example.app.shared.page;

import java.util.List;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * One page of a keyset-paged list, and the JSON shape of every list endpoint: {@code {"items":
 * [...], "next_cursor": "..." | null}}. {@code nextCursor} is null on the last page. There is no
 * total: counting a big table on every request is the cost keyset paging exists to avoid.
 */
public record CursorPage<T>(List<T> items, @Nullable String nextCursor) {

  public CursorPage {
    items = List.copyOf(items);
  }

  /**
   * Builds a page from a fetch of {@code limit + 1} rows: an extra row means there is more, and the
   * cursor then names the last row that is kept (never the extra one, which the next page returns).
   */
  public static <T> CursorPage<T> of(List<T> fetched, int limit, Function<T, Cursor> positionOf) {
    if (fetched.size() <= limit) {
      return new CursorPage<>(fetched, null);
    }
    List<T> kept = fetched.subList(0, limit);
    return new CursorPage<>(kept, positionOf.apply(kept.get(limit - 1)).encode());
  }

  public <R> CursorPage<R> map(Function<? super T, ? extends R> mapper) {
    return new CursorPage<>(items.stream().<R>map(mapper).toList(), nextCursor);
  }
}
