package com.example.system.shared;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import java.util.List;
import org.junit.jupiter.api.Test;

class PageTest {

  @Test
  void queryRejectsNegativePagesAndSizesOutsideOneToOneHundred() {
    assertThatThrownBy(() -> new PageQuery(-1, 10)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new PageQuery(0, 0)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new PageQuery(0, 101)).isInstanceOf(IllegalArgumentException.class);
    assertThat(new PageQuery(0, 100).size()).isEqualTo(100);
  }

  @Test
  void resultComputesTotalPagesRoundingUp() {
    PageResult<String> page = PageResult.of(List.of("a", "b"), new PageQuery(0, 2), 5);

    assertThat(page.totalPages()).isEqualTo(3);
    assertThat(page.totalElements()).isEqualTo(5);
  }

  @Test
  void emptyResultHasZeroPages() {
    assertThat(PageResult.of(List.<String>of(), new PageQuery(0, 20), 0).totalPages()).isZero();
  }

  @Test
  void mapKeepsPagingAndTransformsItems() {
    PageResult<Integer> mapped =
        PageResult.of(List.of("a", "bb"), new PageQuery(1, 2), 4).map(String::length);

    assertThat(mapped.items()).containsExactly(1, 2);
    assertThat(mapped.page()).isEqualTo(1);
    assertThat(mapped.totalPages()).isEqualTo(2);
  }

  @Test
  void resultItemsAreDefensivelyCopied() {
    List<String> source = new java.util.ArrayList<>(List.of("a"));
    PageResult<String> page = PageResult.of(source, new PageQuery(0, 5), 1);
    source.add("b");

    assertThat(page.items()).containsExactly("a");
  }
}
