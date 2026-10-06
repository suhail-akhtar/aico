package com.example.app.items;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.app.items.app.ItemService;
import com.example.app.items.domain.Item;
import com.example.app.items.domain.ItemRepository;
import com.example.app.shared.error.ConflictException;
import com.example.app.shared.error.NotFoundException;
import com.example.app.shared.page.CursorPage;
import com.example.app.shared.page.PageQuery;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ItemServiceTest {

  private static final Instant NOW = Instant.parse("2026-10-06T10:00:00.123456789Z");
  private static final UUID OWNER = UUID.randomUUID();

  @Mock ItemRepository repository;
  ItemService service;

  @BeforeEach
  void setUp() {
    service = new ItemService(repository, Clock.fixed(NOW, ZoneOffset.UTC));
  }

  @Test
  void createStampsTheCallerAsOwnerAndTruncatesTimeToMicroseconds() {
    when(repository.insert(any(Item.class))).thenAnswer(call -> call.getArgument(0));

    Item created = service.create(OWNER, "Widget", null, 4);

    assertThat(created.ownerId()).isEqualTo(OWNER);
    assertThat(created.quantity()).isEqualTo(4);
    assertThat(created.createdAt()).isEqualTo(Instant.parse("2026-10-06T10:00:00.123456Z"));
  }

  @Test
  void getOfAnItemTheCallerDoesNotOwnIsNotFound() {
    UUID id = UUID.randomUUID();
    when(repository.findByIdAndOwner(id, OWNER)).thenReturn(Optional.empty());

    assertThatThrownBy(() -> service.get(OWNER, id)).isInstanceOf(NotFoundException.class);
  }

  @Test
  void updateRefusesAStaleVersionWithoutWriting() {
    Item stored = new Item(UUID.randomUUID(), OWNER, "Old", null, 1, NOW, NOW, 3L);
    when(repository.findByIdAndOwner(stored.id(), OWNER)).thenReturn(Optional.of(stored));

    assertThatThrownBy(() -> service.update(OWNER, stored.id(), "New", null, 0, 2L))
        .isInstanceOfSatisfying(
            ConflictException.class, e -> assertThat(e.code()).isEqualTo("version_conflict"));
    verify(repository, never()).update(any());
  }

  @Test
  void updateWithTheCurrentVersionWrites() {
    Item stored = new Item(UUID.randomUUID(), OWNER, "Old", null, 1, NOW, NOW, 3L);
    when(repository.findByIdAndOwner(stored.id(), OWNER)).thenReturn(Optional.of(stored));
    when(repository.update(any(Item.class))).thenAnswer(call -> call.getArgument(0));

    Item updated = service.update(OWNER, stored.id(), "New", "d", 7, 3L);

    assertThat(updated.name()).isEqualTo("New");
    assertThat(updated.quantity()).isEqualTo(7);
  }

  @Test
  void updateWithoutAVersionSkipsTheCheck() {
    Item stored = new Item(UUID.randomUUID(), OWNER, "Old", null, 1, NOW, NOW, 3L);
    when(repository.findByIdAndOwner(stored.id(), OWNER)).thenReturn(Optional.of(stored));
    when(repository.update(any(Item.class))).thenAnswer(call -> call.getArgument(0));

    assertThat(service.update(OWNER, stored.id(), "New", null, 0, null).name()).isEqualTo("New");
  }

  @Test
  void deleteOfAMissingItemIsNotFound() {
    UUID id = UUID.randomUUID();
    when(repository.deleteByIdAndOwner(id, OWNER)).thenReturn(false);

    assertThatThrownBy(() -> service.delete(OWNER, id)).isInstanceOf(NotFoundException.class);
  }

  @Test
  void deleteOfAnOwnedItemSucceeds() {
    UUID id = UUID.randomUUID();
    when(repository.deleteByIdAndOwner(id, OWNER)).thenReturn(true);

    service.delete(OWNER, id);

    verify(repository).deleteByIdAndOwner(id, OWNER);
  }

  @Test
  void listPassesABlankSearchAsNoFilter() {
    PageQuery page = PageQuery.first();
    when(repository.findByOwner(OWNER, null, page)).thenReturn(new CursorPage<>(List.of(), null));

    assertThat(service.list(OWNER, "   ", page).items()).isEmpty();
    verify(repository).findByOwner(OWNER, null, page);
  }

  @Test
  void listTrimsTheSearchTerm() {
    PageQuery page = PageQuery.first();
    when(repository.findByOwner(OWNER, "wid", page)).thenReturn(new CursorPage<>(List.of(), null));

    service.list(OWNER, "  wid ", page);

    verify(repository).findByOwner(OWNER, "wid", page);
  }
}
