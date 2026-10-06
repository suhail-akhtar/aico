package com.example.system.tasks;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;

import com.example.system.support.IntegrationTest;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import tools.jackson.databind.JsonNode;

/** Uploads and downloads over the real stack, with object storage replaced by a map. */
class AttachmentsApiIT extends IntegrationTest {

  @AfterEach
  void storeIsBackUp() {
    store.setDown(false);
  }

  private MvcTestResult upload(Caller as, String taskId, String name, String type, byte[] bytes) {
    return mvc.post()
        .uri(URI.create("/api/v1/tasks/" + taskId + "/attachments"))
        .queryParam("name", name)
        .contentType(type)
        .content(bytes)
        .with(as.session())
        .with(csrf())
        .exchange();
  }

  @Test
  void aFileCanBeUploadedListedDownloadedAndDeleted() {
    var alice = newMember();
    String task = createTask(alice, "with a file");
    byte[] bytes = "quarterly numbers".getBytes(StandardCharsets.UTF_8);

    MvcTestResult created = upload(alice, task, "numbers.txt", "text/plain", bytes);
    assertThat(created).hasStatus(HttpStatus.CREATED);
    JsonNode meta = body(created);
    String id = meta.path("id").asString();
    assertThat(meta.path("fileName").asString()).isEqualTo("numbers.txt");
    assertThat(meta.path("sizeBytes").asLong()).isEqualTo(bytes.length);
    assertThat(meta.has("objectKey")).as("the storage key is internal").isFalse();

    assertThat(body(get("/api/v1/tasks/" + task + "/attachments", alice))).hasSize(1);

    MvcTestResult download = get("/api/v1/tasks/" + task + "/attachments/" + id, alice);
    assertThat(download).hasStatus(HttpStatus.OK);
    assertThat(download.getResponse().getContentAsByteArray()).isEqualTo(bytes);
    var response = download.getResponse();
    assertThat(response.getHeader(HttpHeaders.CONTENT_DISPOSITION)).startsWith("attachment");
    assertThat(response.getHeader("Content-Security-Policy")).startsWith("sandbox");
    assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
    assertThat(response.getHeader(HttpHeaders.CACHE_CONTROL)).contains("no-store");

    assertThat(delete("/api/v1/tasks/" + task + "/attachments/" + id, alice))
        .hasStatus(HttpStatus.NO_CONTENT);
    assertThat(body(get("/api/v1/tasks/" + task + "/attachments", alice))).isEmpty();
  }

  @Test
  void deletingATaskRemovesItsFilesFromStorage() {
    var alice = newMember();
    String task = createTask(alice, "to delete");
    upload(alice, task, "a.txt", "text/plain", new byte[] {1, 2, 3});
    int before = store.count();
    assertThat(before).isPositive();

    assertThat(delete("/api/v1/tasks/" + task, alice)).hasStatus(HttpStatus.NO_CONTENT);

    assertThat(store.count()).isEqualTo(before - 1);
  }

  @Test
  void someoneElsesTaskCannotBeUploadedToListedOrDownloaded() {
    var alice = newMember();
    var mallory = newMember();
    String task = createTask(alice, "private");
    String id =
        body(upload(alice, task, "a.txt", "text/plain", new byte[] {1})).path("id").asString();

    assertProblem(
        upload(mallory, task, "x.txt", "text/plain", new byte[] {1}),
        HttpStatus.NOT_FOUND,
        "not_found");
    assertProblem(
        get("/api/v1/tasks/" + task + "/attachments", mallory), HttpStatus.NOT_FOUND, "not_found");
    assertProblem(
        get("/api/v1/tasks/" + task + "/attachments/" + id, mallory),
        HttpStatus.NOT_FOUND,
        "not_found");
  }

  @Test
  void typesOutsideTheAllowListAndEmptyBodiesAreRefused() {
    var alice = newMember();
    String task = createTask(alice, "t");

    assertProblem(
        upload(alice, task, "x.html", "text/html", new byte[] {1}),
        HttpStatus.BAD_REQUEST,
        "validation_failed");
    assertProblem(
        upload(alice, task, "x.bin", "application/octet-stream", new byte[] {1}),
        HttpStatus.BAD_REQUEST,
        "validation_failed");
    assertProblem(
        upload(alice, task, "x.txt", "text/plain", new byte[0]),
        HttpStatus.BAD_REQUEST,
        "validation_failed");
    assertProblem(
        upload(alice, task, "x.txt", "not a media type", new byte[] {1}),
        HttpStatus.BAD_REQUEST,
        "validation_failed");
  }

  @Test
  void aFileOverTheLimitIs413BeforeItIsRead() {
    var alice = newMember();
    String task = createTask(alice, "t");
    int before = store.count();

    MvcTestResult result = upload(alice, task, "big.txt", "text/plain", new byte[70 * 1024]);

    assertProblem(result, HttpStatus.CONTENT_TOO_LARGE, "payload_too_large");
    assertThat(store.count()).isEqualTo(before);
  }

  @Test
  void jsonRoutesKeepTheSmallLimitEvenThoughUploadsAreLarger() {
    var alice = newMember();
    String huge = "{\"title\":\"" + "x".repeat(20_000) + "\"}";

    assertProblem(
        post("/api/v1/tasks", alice, huge), HttpStatus.CONTENT_TOO_LARGE, "payload_too_large");
  }

  @Test
  void aStorageOutageIsA503NotAnInternalError() {
    var alice = newMember();
    String task = createTask(alice, "t");
    store.setDown(true);

    assertProblem(
        upload(alice, task, "x.txt", "text/plain", new byte[] {1}),
        HttpStatus.SERVICE_UNAVAILABLE,
        "storage_unavailable");
  }

  @Test
  void aMissingFileNameIsA400() {
    var alice = newMember();
    String task = createTask(alice, "t");

    MvcTestResult result =
        mvc.post()
            .uri(URI.create("/api/v1/tasks/" + task + "/attachments"))
            .contentType("text/plain")
            .content(new byte[] {1})
            .with(alice.session())
            .with(csrf())
            .exchange();

    assertProblem(result, HttpStatus.BAD_REQUEST, "bad_request");
  }
}
