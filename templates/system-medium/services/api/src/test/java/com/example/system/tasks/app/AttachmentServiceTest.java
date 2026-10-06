package com.example.system.tasks.app;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.system.identity.AuthenticatedUser;
import com.example.system.shared.config.AppProperties;
import com.example.system.shared.error.ConflictException;
import com.example.system.shared.error.ForbiddenException;
import com.example.system.shared.error.NotFoundException;
import com.example.system.shared.error.UnavailableException;
import com.example.system.shared.error.ValidationException;
import com.example.system.shared.flags.FeatureFlags;
import com.example.system.support.InMemoryObjectStore;
import com.example.system.tasks.domain.Attachment;
import com.example.system.tasks.domain.Task;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.time.Clock;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.util.unit.DataSize;

/** Attachment rules: ownership, limits, types, names, storage failures, and no orphans. */
class AttachmentServiceTest {

  private static final AuthenticatedUser ALICE =
      new AuthenticatedUser(UUID.randomUUID(), "alice@example.com", "Alice", Set.of("MEMBER"));
  private static final AuthenticatedUser BOB =
      new AuthenticatedUser(UUID.randomUUID(), "bob@example.com", "Bob", Set.of("MEMBER"));

  private final Fakes.Tasks tasks = new Fakes.Tasks();
  private final Fakes.Attachments rows = new Fakes.Attachments();
  private final InMemoryObjectStore store = new InMemoryObjectStore();
  private AttachmentService service;
  private Task task;

  private static AppProperties props() {
    return new AppProperties(
        new AppProperties.Security(false),
        new AppProperties.RateLimit(true, 300, 30),
        new AppProperties.Http(DataSize.ofKilobytes(256), DataSize.ofKilobytes(1)),
        new AppProperties.Jobs(
            false,
            java.time.Duration.ofSeconds(30),
            java.time.Duration.ofSeconds(30),
            java.time.Duration.ofDays(7),
            java.time.Duration.ofDays(30)),
        new AppProperties.Storage("memory", null, "r", "b", null, null, false, true),
        new AppProperties.Flags("memory", "h", 1),
        new AppProperties.Mail("a@example.test", "http://localhost"));
  }

  private AttachmentService serviceWith(boolean attachmentsEnabled) {
    FeatureFlags flags =
        Fakes.flags(
            "attachments-" + attachmentsEnabled,
            Map.of(FeatureFlags.ATTACHMENTS_ENABLED, attachmentsEnabled));
    return new AttachmentService(
        tasks, rows, store, flags, props(), Clock.fixed(Fakes.at(), ZoneOffset.UTC));
  }

  @BeforeEach
  void setUp() {
    service = serviceWith(true);
    task = tasks.insert(Task.create(ALICE.id(), "Has files", null, null, Fakes.at()));
  }

  private Attachment add(AuthenticatedUser who, String name, String type, byte[] bytes) {
    return service.add(who, task.id(), name, type, bytes.length, new ByteArrayInputStream(bytes));
  }

  @Test
  void storesBytesUnderAnIdDerivedKeyAndKeepsMetadata() throws IOException {
    byte[] bytes = "hello".getBytes();

    Attachment a = add(ALICE, "notes.txt", "text/plain", bytes);

    assertThat(a.objectKey()).isEqualTo("tasks/" + task.id() + "/" + a.id());
    assertThat(a.fileName()).isEqualTo("notes.txt");
    assertThat(a.sizeBytes()).isEqualTo(5);
    assertThat(store.get(a.objectKey()).readAllBytes()).isEqualTo(bytes);
    assertThat(service.list(ALICE, task.id())).containsExactly(a);
    try (var download = service.open(ALICE, task.id(), a.id()).content()) {
      assertThat(download.readAllBytes()).isEqualTo(bytes);
    }
  }

  @Test
  void aHostileFileNameNeverReachesTheKeyAndIsReducedToAPlainName() {
    Attachment a = add(ALICE, "../../etc/passwd\u0000.txt", "text/plain", new byte[] {1});

    assertThat(a.objectKey()).startsWith("tasks/" + task.id() + "/").doesNotContain("passwd");
    assertThat(a.fileName()).doesNotContain("/", "..", "\u0000").endsWith(".txt");
  }

  @Test
  void cleanNameHandlesTheEdgeCases() {
    assertThat(AttachmentService.cleanName("C:\\Users\\bob\\report.pdf")).isEqualTo("report.pdf");
    assertThat(AttachmentService.cleanName("a\"b<c>d.png")).isEqualTo("a_b_c_d.png");
    assertThat(AttachmentService.cleanName("..")).isEqualTo("file");
    assertThat(AttachmentService.cleanName("   ")).isEqualTo("file");
    assertThat(AttachmentService.cleanName("x".repeat(500))).hasSize(AttachmentService.NAME_MAX);
  }

  @Test
  void onlyAllowListedTypesAreAccepted() {
    for (String bad : new String[] {"text/html", "image/svg+xml", "application/x-msdownload", ""}) {
      assertThatThrownBy(() -> add(ALICE, "f", bad, new byte[] {1}))
          .as(bad)
          .isInstanceOf(ValidationException.class);
    }
    assertThat(add(ALICE, "f.PNG", "IMAGE/PNG", new byte[] {1}).contentType())
        .isEqualTo("image/png");
  }

  @Test
  void emptyAndOversizedFilesAreRefused() {
    assertThatThrownBy(() -> add(ALICE, "f", "text/plain", new byte[0]))
        .isInstanceOf(ValidationException.class);
    assertThatThrownBy(() -> add(ALICE, "f", "text/plain", new byte[1025]))
        .isInstanceOf(ValidationException.class);
    assertThat(store.count()).isZero();
  }

  @Test
  void aTaskHoldsAtMostFiveAttachments() {
    for (int i = 0; i < AttachmentService.MAX_PER_TASK; i++) {
      add(ALICE, "f" + i, "text/plain", new byte[] {1});
    }

    assertThatThrownBy(() -> add(ALICE, "one-too-many", "text/plain", new byte[] {1}))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void someoneElsesTaskLooksMissingForEveryOperation() {
    Attachment a = add(ALICE, "f", "text/plain", new byte[] {1});

    assertThatThrownBy(() -> add(BOB, "x", "text/plain", new byte[] {1}))
        .isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> service.list(BOB, task.id())).isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> service.open(BOB, task.id(), a.id()))
        .isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> service.delete(BOB, task.id(), a.id()))
        .isInstanceOf(NotFoundException.class);
  }

  @Test
  void anAttachmentOfAnotherTaskIsNotReachableThroughThisOne() {
    Task other = tasks.insert(Task.create(ALICE.id(), "Other", null, null, Fakes.at()));
    Attachment a = add(ALICE, "f", "text/plain", new byte[] {1});

    assertThatThrownBy(() -> service.open(ALICE, other.id(), a.id()))
        .isInstanceOf(NotFoundException.class);
  }

  @Test
  void deleteRemovesTheObjectAndTheRow() {
    Attachment a = add(ALICE, "f", "text/plain", new byte[] {1});

    service.delete(ALICE, task.id(), a.id());

    assertThat(store.contains(a.objectKey())).isFalse();
    assertThat(rows.rows).isEmpty();
  }

  @Test
  void switchedOffUploadsAreForbidden() {
    var off = serviceWith(false);

    assertThatThrownBy(
            () ->
                off.add(
                    ALICE,
                    task.id(),
                    "f",
                    "text/plain",
                    1,
                    new ByteArrayInputStream(new byte[] {1})))
        .isInstanceOf(ForbiddenException.class)
        .extracting("code")
        .isEqualTo("feature_disabled");
  }

  @Test
  void aStorageOutageAnswersUnavailableAndLeavesNoRow() {
    store.setDown(true);

    assertThatThrownBy(() -> add(ALICE, "f", "text/plain", new byte[] {1}))
        .isInstanceOf(UnavailableException.class);
    assertThat(rows.rows).isEmpty();
    assertThatCode(() -> service.removeAllObjects(task.id())).doesNotThrowAnyException();
  }

  @Test
  void aFailedRowInsertRemovesTheBytesAgain() {
    rows.failInsert = () -> new IllegalStateException("database is down");

    assertThatThrownBy(() -> add(ALICE, "f", "text/plain", new byte[] {1}))
        .isInstanceOf(IllegalStateException.class);

    assertThat(store.count()).as("no orphaned object").isZero();
  }

  @Test
  void downloadAndDeleteReportStorageOutages() {
    Attachment a = add(ALICE, "f", "text/plain", new byte[] {1});
    store.setDown(true);

    assertThatThrownBy(() -> service.open(ALICE, task.id(), a.id()))
        .isInstanceOf(UnavailableException.class);
    assertThatThrownBy(() -> service.delete(ALICE, task.id(), a.id()))
        .isInstanceOf(UnavailableException.class);
    assertThatThrownBy(() -> service.removeAllObjects(task.id()))
        .isInstanceOf(UnavailableException.class);
  }
}
