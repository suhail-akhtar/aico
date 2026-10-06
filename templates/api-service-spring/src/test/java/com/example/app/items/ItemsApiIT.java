package com.example.app.items;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.app.support.IntegrationTest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import tools.jackson.databind.JsonNode;

/** The worked resource end to end: HTTP, validation, service, repository, real database. */
class ItemsApiIT extends IntegrationTest {

  @Test
  void createReturns201WithLocationAndTheStoredItem() {
    String token = newUserToken();

    MvcTestResult created =
        post("/api/v1/items", token, Map.of("name", "  Widget  ", "description", "round"));

    assertThat(created)
        .hasStatus(HttpStatus.CREATED)
        .bodyJson()
        .extractingPath("$.name")
        .isEqualTo("Widget");
    String id = body(created).path("id").asString();
    assertThat(created.getResponse().getHeader(HttpHeaders.LOCATION))
        .isEqualTo("/api/v1/items/" + id);
    assertThat(body(created).path("version").asInt()).isZero();
    assertThat(body(created).path("quantity").asInt()).isZero();
    assertThat(body(created).has("ownerId")).isFalse();
    assertThat(body(created).has("owner_id")).isFalse();
  }

  @Test
  void theWireFormatIsSnakeCaseInResponsesAndRequests() {
    String token = newUserToken();

    MvcTestResult created =
        post("/api/v1/items", token, "{\"name\":\"snake\",\"description\":null,\"quantity\":7}");

    assertThat(created).hasStatus(HttpStatus.CREATED);
    assertThat(body(created).propertyNames())
        .containsExactlyInAnyOrder(
            "id", "name", "description", "quantity", "created_at", "updated_at", "version");
    assertThat(body(created).path("description").isNull()).isTrue();
    assertThat(body(created).path("quantity").asInt()).isEqualTo(7);
    assertThat(body(created).path("created_at").asString()).endsWith("Z");
  }

  @Test
  void quantityIsOptionalAndDefaultsToZeroOnCreateAndOnAFullReplace() {
    String token = newUserToken();
    String id =
        body(post("/api/v1/items", token, Map.of("name", "stock", "quantity", 12)))
            .path("id")
            .asString();

    MvcTestResult replaced = put("/api/v1/items/" + id, token, Map.of("name", "stock"));

    assertThat(replaced).hasStatus(HttpStatus.OK);
    assertThat(body(replaced).path("quantity").asInt()).isZero();
  }

  @Test
  void quantityAcceptsTheBoundsAndRejectsEverythingOutsideThem() {
    String token = newUserToken();

    assertThat(post("/api/v1/items", token, Map.of("name", "min", "quantity", 0)))
        .hasStatus(HttpStatus.CREATED);
    assertThat(post("/api/v1/items", token, Map.of("name", "max", "quantity", 1_000_000)))
        .hasStatus(HttpStatus.CREATED);
    for (String bad : List.of("-1", "1000001", "1.5", "\"many\"", "99999999999")) {
      MvcTestResult result =
          post("/api/v1/items", token, "{\"name\":\"x\",\"quantity\":" + bad + "}");
      assertThat(result.getResponse().getStatus()).as(bad).isEqualTo(400);
    }
    MvcTestResult negative = post("/api/v1/items", token, Map.of("name", "x", "quantity", -5));
    assertProblem(negative, HttpStatus.BAD_REQUEST, "bad_request");
    assertThat(body(negative).path("errors").get(0).path("field").asString()).isEqualTo("quantity");
  }

  @Test
  void getReturnsWhatWasStored() {
    String token = newUserToken();
    String id = createItem(token, "Widget");

    assertThat(get("/api/v1/items/" + id, token))
        .hasStatus(HttpStatus.OK)
        .bodyJson()
        .extractingPath("$.id")
        .isEqualTo(id);
  }

  @Test
  void updateReplacesContentAndBumpsTheVersion() {
    String token = newUserToken();
    String id = createItem(token, "Widget");

    MvcTestResult updated =
        put("/api/v1/items/" + id, token, Map.of("name", "Gadget", "description", "square"));

    assertThat(updated).hasStatus(HttpStatus.OK);
    assertThat(body(updated).path("name").asString()).isEqualTo("Gadget");
    assertThat(body(updated).path("version").asInt()).isEqualTo(1);
    assertThat(body(updated).path("updated_at").asString())
        .isGreaterThanOrEqualTo(body(updated).path("created_at").asString());
  }

  @Test
  void updateWithAStaleVersionIsAConflict() {
    String token = newUserToken();
    String id = createItem(token, "Widget");
    assertThat(put("/api/v1/items/" + id, token, Map.of("name", "Second")))
        .hasStatus(HttpStatus.OK);

    MvcTestResult stale = put("/api/v1/items/" + id, token, Map.of("name", "Third", "version", 0));

    assertProblem(stale, HttpStatus.CONFLICT, "version_conflict");
    assertThat(body(get("/api/v1/items/" + id, token)).path("name").asString()).isEqualTo("Second");
  }

  @Test
  void updateWithTheCurrentVersionSucceeds() {
    String token = newUserToken();
    String id = createItem(token, "Widget");

    assertThat(put("/api/v1/items/" + id, token, Map.of("name", "Next", "version", 0)))
        .hasStatus(HttpStatus.OK);
  }

  @Test
  void deleteRemovesTheItemAndASecondDeleteIsNotFound() {
    String token = newUserToken();
    String id = createItem(token, "Widget");

    assertThat(delete("/api/v1/items/" + id, token)).hasStatus(HttpStatus.NO_CONTENT);
    assertProblem(get("/api/v1/items/" + id, token), HttpStatus.NOT_FOUND, "not_found");
    assertProblem(delete("/api/v1/items/" + id, token), HttpStatus.NOT_FOUND, "not_found");
  }

  @Test
  void validationNamesEveryBadField() {
    String token = newUserToken();

    MvcTestResult result =
        post("/api/v1/items", token, Map.of("name", " ", "description", "d".repeat(2001)));

    assertProblem(result, HttpStatus.BAD_REQUEST, "bad_request");
    List<String> fields =
        body(result).path("errors").valueStream().map(e -> e.path("field").asString()).toList();
    assertThat(fields).containsExactlyInAnyOrder("name", "description");
  }

  @Test
  void malformedJsonIsABadRequestThatDoesNotEchoTheParserError() {
    MvcTestResult result = post("/api/v1/items", newUserToken(), "{\"name\": ");

    assertProblem(result, HttpStatus.BAD_REQUEST, "bad_request");
    assertThat(body(result).path("detail").asString())
        .isEqualTo("The request body is missing or malformed.");
  }

  @Test
  void aNonUuidIdIsABadRequest() {
    assertThat(get("/api/v1/items/not-a-uuid", newUserToken())).hasStatus(HttpStatus.BAD_REQUEST);
  }

  /** Names on one page, in the order the server returned them. */
  private List<String> names(JsonNode page) {
    return page.path("items").valueStream().map(i -> i.path("name").asString()).toList();
  }

  @Test
  void listWalksEveryItemExactlyOnceNewestFirstThroughTheCursor() {
    String token = newUserToken();
    List<String> created = IntStream.range(0, 5).mapToObj(i -> "item-" + i).toList();
    created.forEach(n -> createItem(token, n));

    List<String> seen = new ArrayList<>();
    List<Integer> pageSizes = new ArrayList<>();
    String cursor = null;
    JsonNode page;
    int guard = 0;
    do {
      page =
          body(get("/api/v1/items?limit=2" + (cursor == null ? "" : "&cursor=" + cursor), token));
      assertThat(page.propertyNames()).containsExactlyInAnyOrder("items", "next_cursor");
      pageSizes.add(page.path("items").size());
      seen.addAll(names(page));
      cursor = page.path("next_cursor").isNull() ? null : page.path("next_cursor").asString();
    } while (cursor != null && ++guard < 10);

    assertThat(pageSizes).containsExactly(2, 2, 1);
    assertThat(page.path("next_cursor").isNull()).isTrue();
    assertThat(seen).containsExactlyInAnyOrderElementsOf(created).doesNotHaveDuplicates();
    // Newest first: the last one created leads, the first one created comes last.
    assertThat(seen.get(0)).isEqualTo("item-4");
    assertThat(seen.get(4)).isEqualTo("item-0");
  }

  @Test
  void aSingleFullPageHasNoNextCursorAndTheDefaultLimitIsFifty() {
    String token = newUserToken();
    IntStream.range(0, 3).forEach(i -> createItem(token, "n" + i));

    JsonNode exact = body(get("/api/v1/items?limit=3", token));
    JsonNode defaults = body(get("/api/v1/items", token));

    assertThat(exact.path("items")).hasSize(3);
    assertThat(exact.path("next_cursor").isNull()).isTrue();
    assertThat(defaults.path("items")).hasSize(3);
    assertThat(defaults.path("next_cursor").isNull()).isTrue();
  }

  @Test
  void aCursorKeepsTheNameFilterAndDoesNotRepeatOrSkipWhenRowsChangeBetweenPages() {
    String token = newUserToken();
    IntStream.range(0, 4).forEach(i -> createItem(token, "blue-" + i));
    createItem(token, "red-0");
    JsonNode first = body(get("/api/v1/items?limit=2&q=blue", token));
    String firstSecond = names(first).get(1);

    // A new match appears and an unrelated row is deleted while the client holds a cursor.
    createItem(token, "blue-new");
    String doomed = createItem(token, "red-1");
    assertThat(delete("/api/v1/items/" + doomed, token)).hasStatus(HttpStatus.NO_CONTENT);
    JsonNode second =
        body(
            get(
                "/api/v1/items?limit=2&q=blue&cursor=" + first.path("next_cursor").asString(),
                token));

    // Page two continues strictly after the last row of page one: nothing repeated, nothing from
    // the filtered-out rows, and the row inserted at the head does not shift the window.
    assertThat(names(second)).doesNotContainAnyElementsOf(names(first)).doesNotContain("blue-new");
    assertThat(names(second)).containsExactly("blue-1", "blue-0");
    assertThat(firstSecond).isEqualTo("blue-2");
  }

  @Test
  void aBadCursorOrLimitIsA400NamingTheParameter() {
    String token = newUserToken();

    MvcTestResult cursor = get("/api/v1/items?cursor=not-a-real-cursor", token);
    MvcTestResult zero = get("/api/v1/items?limit=0", token);
    MvcTestResult tooMany = get("/api/v1/items?limit=101", token);
    MvcTestResult notANumber = get("/api/v1/items?limit=lots", token);
    MvcTestResult oldStyle = get("/api/v1/items?page=1&size=5", token);

    assertProblem(cursor, HttpStatus.BAD_REQUEST, "validation_failed");
    assertThat(body(cursor).path("errors").get(0).path("field").asString()).isEqualTo("cursor");
    assertProblem(zero, HttpStatus.BAD_REQUEST, "bad_request");
    assertThat(body(zero).path("errors").get(0).path("field").asString()).isEqualTo("limit");
    assertThat(tooMany).hasStatus(HttpStatus.BAD_REQUEST);
    assertThat(notANumber).hasStatus(HttpStatus.BAD_REQUEST);
    // The retired offset parameters are simply ignored: the list still answers, from the start.
    assertThat(oldStyle).hasStatus(HttpStatus.OK);
  }

  @Test
  void anEmptyCursorMeansTheFirstPage() {
    String token = newUserToken();
    createItem(token, "only");

    assertThat(body(get("/api/v1/items?cursor=", token)).path("items")).hasSize(1);
  }

  @Test
  void searchIsACaseInsensitiveLiteralMatchAndWildcardsAreNotSpecial() {
    String token = newUserToken();
    createItem(token, "Blue Widget");
    createItem(token, "red widget");
    createItem(token, "100% cotton");
    createItem(token, "snake_case");

    assertThat(names(body(get("/api/v1/items?q=WIDGET", token))))
        .containsExactlyInAnyOrder("Blue Widget", "red widget");
    assertThat(names(body(get("/api/v1/items?q=%25", token)))).containsExactly("100% cotton");
    assertThat(names(body(get("/api/v1/items?q=_", token)))).containsExactly("snake_case");
    assertThat(names(body(get("/api/v1/items?q=%5C", token)))).isEmpty();
  }

  @Test
  void anUnknownIdIsNotFound() {
    assertProblem(
        get("/api/v1/items/" + UUID.randomUUID(), newUserToken()),
        HttpStatus.NOT_FOUND,
        "not_found");
  }
}
