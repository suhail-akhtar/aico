package com.example.system.shared.page;

import java.util.List;
import java.util.function.Function;

/** One page of results, also the JSON shape of every list endpoint. */
public record PageResult<T>(List<T> items, int page, int size, long totalElements, int totalPages) {

  public PageResult {
    items = List.copyOf(items);
  }

  public static <T> PageResult<T> of(List<T> items, PageQuery query, long totalElements) {
    int totalPages = (int) Math.ceil((double) totalElements / query.size());
    return new PageResult<>(items, query.page(), query.size(), totalElements, totalPages);
  }

  public <R> PageResult<R> map(Function<? super T, ? extends R> mapper) {
    return new PageResult<>(
        items.stream().<R>map(mapper).toList(), page, size, totalElements, totalPages);
  }
}
