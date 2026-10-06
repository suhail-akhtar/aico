package com.example.app.shared;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.app.shared.error.ValidationException;
import com.example.app.shared.page.Cursor;
import com.example.app.shared.page.CursorPage;
import com.example.app.shared.page.PageQuery;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class PageTest {

  private static final Instant T = Instant.parse("2026-10-06T10:00:00.123456Z");

  private static String b64(String raw) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void queryRejectsLimitsOutsideOneToOneHundredAndDefaultsToFifty() {
    assertThatThrownBy(() -> new PageQuery(0, null)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> new PageQuery(101, null)).isInstanceOf(IllegalArgumentException.class);
    assertThat(new PageQuery(100, null).limit()).isEqualTo(100);
    assertThat(PageQuery.first().limit()).isEqualTo(50);
    assertThat(PageQuery.first().after()).isNull();
  }

  @Test
  void aCursorRoundTripsExactly() {
    Cursor cursor = new Cursor(T, UUID.randomUUID());

    assertThat(Cursor.decode(cursor.encode())).isEqualTo(cursor);
  }

  @Test
  void aCursorKeepsMicrosecondPrecisionAndDropsNanoseconds() {
    Cursor cursor = new Cursor(Instant.parse("2026-10-06T10:00:00.123456789Z"), UUID.randomUUID());

    assertThat(cursor.createdAt()).isEqualTo(T);
    assertThat(Cursor.decode(cursor.encode()).createdAt()).isEqualTo(T);
  }

  @Test
  void aCursorIsOpaqueAndUrlSafe() {
    String token = new Cursor(T, UUID.randomUUID()).encode();

    assertThat(token).matches("[A-Za-z0-9_-]+").doesNotContain("=");
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "",
        "!!!",
        "bm90LWEtY3Vyc29y",
        "x",
        "OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTlfMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAw"
      })
  void aMangledCursorIsAValidationErrorNamingTheField(String garbage) {
    assertThatThrownBy(() -> Cursor.decode(garbage))
        .isInstanceOfSatisfying(
            ValidationException.class,
            e ->
                assertThat(e.violations())
                    .singleElement()
                    .satisfies(v -> assertThat(v.field()).isEqualTo("cursor")));
  }

  @Test
  void aWellFormedLookingCursorWithABadUuidOrNumberIsRefused() {
    String badUuid = b64("123_not-a-uuid");
    String badNumber = b64("abc_" + UUID.randomUUID());
    String outOfRange = b64("99999999999999999999_" + UUID.randomUUID());

    assertThatThrownBy(() -> Cursor.decode(badUuid)).isInstanceOf(ValidationException.class);
    assertThatThrownBy(() -> Cursor.decode(badNumber)).isInstanceOf(ValidationException.class);
    assertThatThrownBy(() -> Cursor.decode(outOfRange)).isInstanceOf(ValidationException.class);
  }

  @Test
  void aFullFetchMeansThereIsANextPageAndTheCursorNamesTheLastKeptRow() {
    UUID id = UUID.randomUUID();

    CursorPage<Integer> page =
        CursorPage.of(List.of(1, 2, 3), 2, row -> new Cursor(T, row == 2 ? id : UUID.randomUUID()));

    assertThat(page.items()).containsExactly(1, 2);
    assertThat(page.nextCursor()).isNotNull();
    assertThat(Cursor.decode(page.nextCursor())).isEqualTo(new Cursor(T, id));
  }

  @Test
  void aShortFetchIsTheLastPageWithNoCursor() {
    CursorPage<Integer> exact =
        CursorPage.of(List.of(1, 2), 2, row -> new Cursor(T, UUID.randomUUID()));
    CursorPage<Integer> empty =
        CursorPage.of(List.of(), 2, row -> new Cursor(T, UUID.randomUUID()));

    assertThat(exact.items()).containsExactly(1, 2);
    assertThat(exact.nextCursor()).isNull();
    assertThat(empty.items()).isEmpty();
    assertThat(empty.nextCursor()).isNull();
  }

  @Test
  void mapKeepsTheCursorAndTransformsItems() {
    CursorPage<Integer> mapped = new CursorPage<>(List.of("a", "bb"), "next").map(String::length);

    assertThat(mapped.items()).containsExactly(1, 2);
    assertThat(mapped.nextCursor()).isEqualTo("next");
  }

  @Test
  void pageItemsAreDefensivelyCopied() {
    List<String> source = new ArrayList<>(List.of("a"));
    CursorPage<String> page = new CursorPage<>(source, null);
    source.add("b");

    assertThat(page.items()).containsExactly("a");
  }
}
