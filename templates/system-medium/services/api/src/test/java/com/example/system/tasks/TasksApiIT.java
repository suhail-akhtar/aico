package com.example.system.tasks;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.system.support.IntegrationTest;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import tools.jackson.databind.JsonNode;

/** The tasks API over the real stack: the happy path, ownership, validation and concurrency. */
class TasksApiIT extends IntegrationTest {

  @Test
  void aCallerCanCreateReadUpdateCompleteAndDeleteATask() {
    var alice = newMember();

    MvcTestResult created =
        post(
            "/api/v1/tasks",
            alice,
            Map.of(
                "title",
                "Write the report",
                "description",
                "Q3",
                "assigneeEmail",
                "bob@example.com"));
    assertThat(created).hasStatus(HttpStatus.CREATED);
    JsonNode task = body(created);
    String id = task.path("id").asString();
    assertThat(created.getResponse().getHeader("Location")).isEqualTo("/api/v1/tasks/" + id);
    assertThat(task.path("status").asString()).isEqualTo("OPEN");
    assertThat(task.path("assigneeEmail").asString()).isEqualTo("bob@example.com");

    assertThat(body(get("/api/v1/tasks/" + id, alice)).path("title").asString())
        .isEqualTo("Write the report");

    long version = task.path("version").asLong();
    MvcTestResult updated =
        put(
            "/api/v1/tasks/" + id,
            alice,
            Map.of("title", "Write the Q3 report", "version", version));
    assertThat(updated).hasStatus(HttpStatus.OK);
    assertThat(body(updated).path("title").asString()).isEqualTo("Write the Q3 report");
    assertThat(body(updated).path("version").asLong()).isGreaterThan(version);

    MvcTestResult done = post("/api/v1/tasks/" + id + "/complete", alice, null);
    assertThat(done).hasStatus(HttpStatus.OK);
    assertThat(body(done).path("status").asString()).isEqualTo("DONE");
    assertThat(post("/api/v1/tasks/" + id + "/complete", alice, null)).hasStatus(HttpStatus.OK);

    assertThat(delete("/api/v1/tasks/" + id, alice)).hasStatus(HttpStatus.NO_CONTENT);
    assertProblem(get("/api/v1/tasks/" + id, alice), HttpStatus.NOT_FOUND, "not_found");
  }

  @Test
  void anotherUsersTaskIsIndistinguishableFromAMissingOne() {
    var alice = newMember();
    var mallory = newMember();
    String id = createTask(alice, "private");

    assertProblem(get("/api/v1/tasks/" + id, mallory), HttpStatus.NOT_FOUND, "not_found");
    assertProblem(
        put("/api/v1/tasks/" + id, mallory, Map.of("title", "x")),
        HttpStatus.NOT_FOUND,
        "not_found");
    assertProblem(
        post("/api/v1/tasks/" + id + "/complete", mallory, null),
        HttpStatus.NOT_FOUND,
        "not_found");
    assertProblem(delete("/api/v1/tasks/" + id, mallory), HttpStatus.NOT_FOUND, "not_found");
    assertThat(body(get("/api/v1/tasks", mallory)).path("totalElements").asLong()).isZero();
    assertThat(get("/api/v1/tasks/" + id, alice)).hasStatus(HttpStatus.OK);
  }

  @Test
  void listingIsNewestFirstPagedAndFilterable() {
    var alice = newMember();
    createTask(alice, "Alpha report");
    String beta = createTask(alice, "Beta");
    createTask(alice, "Gamma report");
    post("/api/v1/tasks/" + beta + "/complete", alice, null);

    JsonNode page = body(get("/api/v1/tasks?size=2", alice));
    assertThat(page.path("totalElements").asLong()).isEqualTo(3);
    assertThat(page.path("totalPages").asInt()).isEqualTo(2);
    assertThat(page.path("items")).hasSize(2);
    assertThat(page.path("items").get(0).path("title").asString()).isEqualTo("Gamma report");

    assertThat(
            body(get("/api/v1/tasks?status=DONE", alice))
                .path("items")
                .get(0)
                .path("title")
                .asString())
        .isEqualTo("Beta");
    assertThat(body(get("/api/v1/tasks?q=REPORT", alice)).path("totalElements").asLong())
        .isEqualTo(2);
    assertThat(
            body(get("/api/v1/tasks?q=report&status=OPEN", alice)).path("totalElements").asLong())
        .isEqualTo(2);
  }

  @Test
  void aSearchStringIsDataNotSqlOrAPattern() {
    var alice = newMember();
    createTask(alice, "100% done");
    createTask(alice, "plain");

    assertThat(body(get("/api/v1/tasks?q=%25", alice)).path("totalElements").asLong()).isEqualTo(1);
    assertThat(body(get("/api/v1/tasks?q=_", alice)).path("totalElements").asLong()).isZero();
    assertThat(get("/api/v1/tasks?q=%27%3B%20drop%20table%20tasks%3B%20--", alice))
        .hasStatus(HttpStatus.OK);
  }

  @Test
  void hostileTextIsStoredAndReturnedAsPlainData() {
    var alice = newMember();
    String title = "<script>alert(1)</script> '; drop table tasks; --";

    JsonNode created = body(post("/api/v1/tasks", alice, Map.of("title", title)));

    assertThat(created.path("title").asString()).isEqualTo(title);
    assertThat(get("/api/v1/tasks", alice)).hasStatus(HttpStatus.OK);
  }

  @Test
  void invalidInputIsA400WithTheFieldsNamed() {
    var alice = newMember();

    MvcTestResult result =
        post("/api/v1/tasks", alice, Map.of("title", " ", "assigneeEmail", "nope"));

    assertProblem(result, HttpStatus.BAD_REQUEST, "bad_request");
    assertThat(text(result)).contains("title");
  }

  @Test
  void controlCharactersAndNulBytesAreRefusedNotA500() {
    var alice = newMember();

    assertProblem(
        post("/api/v1/tasks", alice, "{\"title\":\"a\\u0000b\"}"),
        HttpStatus.BAD_REQUEST,
        "validation_failed");
    assertProblem(
        post("/api/v1/tasks", alice, "{\"title\":\"ok\",\"description\":\"x\\u0000y\"}"),
        HttpStatus.BAD_REQUEST,
        "validation_failed");
  }

  @Test
  void malformedBodiesAndParametersAre400() {
    var alice = newMember();

    assertProblem(post("/api/v1/tasks", alice, "{not json"), HttpStatus.BAD_REQUEST, "bad_request");
    assertProblem(post("/api/v1/tasks", alice, "[]"), HttpStatus.BAD_REQUEST, "bad_request");
    assertProblem(get("/api/v1/tasks/not-a-uuid", alice), HttpStatus.BAD_REQUEST, "bad_request");
    assertProblem(get("/api/v1/tasks?size=1000", alice), HttpStatus.BAD_REQUEST, "bad_request");
    assertProblem(get("/api/v1/tasks?page=-1", alice), HttpStatus.BAD_REQUEST, "bad_request");
    assertProblem(get("/api/v1/tasks?status=BOGUS", alice), HttpStatus.BAD_REQUEST, "bad_request");
  }

  @Test
  void anOversizedBodyIs413BeforeItIsParsed() {
    var alice = newMember();
    String huge = "{\"title\":\"" + "x".repeat(20_000) + "\"}";

    assertProblem(
        post("/api/v1/tasks", alice, huge), HttpStatus.CONTENT_TOO_LARGE, "payload_too_large");
  }

  @Test
  void aStaleVersionIsA409AndTheNewerChangeSurvives() {
    var alice = newMember();
    JsonNode task = body(post("/api/v1/tasks", alice, Map.of("title", "v1")));
    String id = task.path("id").asString();
    long version = task.path("version").asLong();
    assertThat(put("/api/v1/tasks/" + id, alice, Map.of("title", "v2", "version", version)))
        .hasStatus(HttpStatus.OK);

    MvcTestResult stale =
        put("/api/v1/tasks/" + id, alice, Map.of("title", "v3", "version", version));

    assertProblem(stale, HttpStatus.CONFLICT, "version_conflict");
    assertThat(body(get("/api/v1/tasks/" + id, alice)).path("title").asString()).isEqualTo("v2");
  }

  @Test
  void theBrowserCannotCacheTaskResponses() {
    var alice = newMember();

    var response = get("/api/v1/tasks", alice).getResponse();

    assertThat(response.getHeader("Cache-Control")).contains("no-store");
  }
}
