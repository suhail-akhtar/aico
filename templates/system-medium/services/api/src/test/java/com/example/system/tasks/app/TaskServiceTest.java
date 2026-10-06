package com.example.system.tasks.app;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import com.example.system.identity.AuthenticatedUser;
import com.example.system.shared.error.ConflictException;
import com.example.system.shared.error.NotFoundException;
import com.example.system.shared.error.ValidationException;
import com.example.system.shared.flags.FeatureFlags;
import com.example.system.shared.page.PageQuery;
import com.example.system.tasks.domain.Task;
import com.example.system.tasks.domain.TaskStatus;
import com.example.system.tasks.domain.event.TaskAssigned;
import com.example.system.tasks.domain.event.TaskCompleted;
import com.example.system.tasks.domain.event.TaskCreated;
import com.example.system.tasks.domain.event.TaskDeleted;
import com.example.system.tasks.domain.event.TaskEvent;
import java.time.Clock;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The use cases, with in-memory repositories and a recording event publisher. */
class TaskServiceTest {

  private static final AuthenticatedUser ALICE =
      new AuthenticatedUser(UUID.randomUUID(), "alice@example.com", "Alice", Set.of("MEMBER"));
  private static final AuthenticatedUser BOB =
      new AuthenticatedUser(UUID.randomUUID(), "bob@example.com", "Bob", Set.of("MEMBER"));

  private final Fakes.Tasks tasks = new Fakes.Tasks();
  private final AttachmentService attachments = mock(AttachmentService.class);
  private final List<Object> published = new ArrayList<>();
  private TaskService service;

  @BeforeEach
  void setUp() {
    FeatureFlags flags =
        Fakes.flags("task-service-test", Map.of(FeatureFlags.MAX_OPEN_TASKS_PER_USER, 3));
    service =
        new TaskService(
            tasks, attachments, published::add, flags, Clock.fixed(Fakes.at(), ZoneOffset.UTC));
  }

  private <T extends TaskEvent> List<T> events(Class<T> type) {
    return published.stream().filter(type::isInstance).map(type::cast).toList();
  }

  @Test
  void createStoresTheTaskForTheCallerAndPublishesCreated() {
    Task task = service.create(ALICE, "Write report", "details", null);

    assertThat(tasks.rows).containsKey(task.id());
    assertThat(task.ownerId()).isEqualTo(ALICE.id());
    assertThat(events(TaskCreated.class))
        .singleElement()
        .satisfies(
            e -> {
              assertThat(e.taskId()).isEqualTo(task.id());
              assertThat(e.actorId()).isEqualTo(ALICE.id());
              assertThat(e.actorLabel()).isEqualTo("alice@example.com");
              assertThat(e.type()).isEqualTo("task.created");
            });
    assertThat(events(TaskAssigned.class)).isEmpty();
  }

  @Test
  void createWithAnAssigneePublishesAssignedWithAFreshEventId() {
    Task task = service.create(ALICE, "Review", null, "bob@example.com");

    assertThat(events(TaskAssigned.class))
        .singleElement()
        .satisfies(
            e -> {
              assertThat(e.assigneeEmail()).isEqualTo("bob@example.com");
              assertThat(e.taskId()).isEqualTo(task.id());
              assertThat(e.eventId()).isNotEqualTo(events(TaskCreated.class).getFirst().eventId());
            });
  }

  @Test
  void aCallerCannotHaveMoreOpenTasksThanTheFlagAllows() {
    service.create(ALICE, "1", null, null);
    service.create(ALICE, "2", null, null);
    service.create(ALICE, "3", null, null);

    assertThatThrownBy(() -> service.create(ALICE, "4", null, null))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("3 open tasks");
    // Someone else is not affected, and finishing a task frees a slot.
    assertThat(service.create(BOB, "mine", null, null)).isNotNull();
    Task first = service.list(ALICE, null, null, new PageQuery(0, 10)).items().getFirst();
    service.complete(ALICE, first.id());
    assertThat(service.create(ALICE, "4", null, null)).isNotNull();
  }

  @Test
  void anInvalidTaskIsRefusedAndNothingIsPublished() {
    assertThatThrownBy(() -> service.create(ALICE, "  ", null, null))
        .isInstanceOf(ValidationException.class);

    assertThat(published).isEmpty();
    assertThat(tasks.rows).isEmpty();
  }

  @Test
  void aForeignTaskLooksLikeAMissingOne() {
    Task task = service.create(ALICE, "private", null, null);

    assertThatThrownBy(() -> service.get(BOB, task.id())).isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> service.complete(BOB, task.id()))
        .isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> service.delete(BOB, task.id())).isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> service.update(BOB, task.id(), "x", null, null, null))
        .isInstanceOf(NotFoundException.class);
    assertThat(tasks.rows).containsKey(task.id());
  }

  @Test
  void updateAppliesChangesAndAnnouncesOnlyANewAssignee() {
    Task task = service.create(ALICE, "Plan", null, "bob@example.com");
    published.clear();

    service.update(ALICE, task.id(), "Plan v2", "more", "bob@example.com", null);
    assertThat(events(TaskAssigned.class)).as("same assignee: no new mail").isEmpty();

    service.update(ALICE, task.id(), "Plan v2", "more", "carol@example.com", null);
    assertThat(events(TaskAssigned.class))
        .singleElement()
        .satisfies(e -> assertThat(e.assigneeEmail()).isEqualTo("carol@example.com"));

    published.clear();
    service.update(ALICE, task.id(), "Plan v2", "more", null, null);
    assertThat(events(TaskAssigned.class)).as("unassigning sends nothing").isEmpty();
    assertThat(service.get(ALICE, task.id()).title()).isEqualTo("Plan v2");
  }

  @Test
  void aStaleVersionIsRefusedInsteadOfOverwriting() {
    Task task = service.create(ALICE, "Plan", null, null);
    service.update(ALICE, task.id(), "Plan v2", null, null, task.version());

    assertThatThrownBy(
            () -> service.update(ALICE, task.id(), "Plan v3", null, null, task.version()))
        .isInstanceOf(ConflictException.class)
        .extracting("code")
        .isEqualTo("version_conflict");
    assertThat(service.get(ALICE, task.id()).title()).isEqualTo("Plan v2");
  }

  @Test
  void completePublishesOnceAndIsIdempotent() {
    Task task = service.create(ALICE, "Ship", null, null);
    published.clear();

    Task done = service.complete(ALICE, task.id());
    Task again = service.complete(ALICE, task.id());

    assertThat(done.status()).isEqualTo(TaskStatus.DONE);
    assertThat(again.status()).isEqualTo(TaskStatus.DONE);
    assertThat(events(TaskCompleted.class)).hasSize(1);
  }

  @Test
  void deleteRemovesObjectsFirstThenTheTaskAndPublishesDeleted() {
    Task task = service.create(ALICE, "Temp", null, null);
    published.clear();

    service.delete(ALICE, task.id());

    verify(attachments).removeAllObjects(task.id());
    assertThat(tasks.rows).doesNotContainKey(task.id());
    assertThat(events(TaskDeleted.class))
        .singleElement()
        .satisfies(e -> assertThat(e.taskId()).isEqualTo(task.id()));
  }

  @Test
  void listFiltersByStatusAndTitleForTheCallerOnly() {
    service.create(ALICE, "Alpha report", null, null);
    Task beta = service.create(ALICE, "Beta", null, null);
    service.create(BOB, "Alpha for bob", null, null);
    service.complete(ALICE, beta.id());

    var page = new PageQuery(0, 10);
    assertThat(service.list(ALICE, null, null, page).totalElements()).isEqualTo(2);
    assertThat(service.list(ALICE, TaskStatus.DONE, null, page).items())
        .extracting(Task::title)
        .containsExactly("Beta");
    assertThat(service.list(ALICE, null, " alpha ", page).items())
        .extracting(Task::title)
        .containsExactly("Alpha report");
    assertThat(service.list(ALICE, null, "  ", page).totalElements()).isEqualTo(2);
    assertThat(service.listAll(page).totalElements()).isEqualTo(3);
  }
}
