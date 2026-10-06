package com.example.app.items;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.app.identity.domain.Account;
import com.example.app.identity.domain.AccountRepository;
import com.example.app.items.domain.Item;
import com.example.app.items.domain.ItemRepository;
import com.example.app.shared.error.ConflictException;
import com.example.app.shared.page.Cursor;
import com.example.app.shared.page.PageQuery;
import com.example.app.support.IntegrationTest;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Repository adapters against the real database: the schema Flyway built, ownership scoping,
 * cascades and the unique index that backs registration. Runs on PostgreSQL when Docker is there.
 */
class PersistenceIT extends IntegrationTest {

  @Autowired ItemRepository items;
  @Autowired AccountRepository accounts;
  @Autowired DataSource dataSource;
  @Autowired TransactionTemplate tx;

  private Account newAccount() {
    return accounts.insert(
        new Account(
            UUID.randomUUID(),
            uniqueEmail(),
            "hash",
            Instant.now().truncatedTo(ChronoUnit.MICROS)));
  }

  @Test
  void flywayAppliedTheMigrationsAndRecordedThem() {
    var jdbc = new JdbcTemplate(dataSource);

    Integer applied =
        jdbc.queryForObject(
            "select count(*) from flyway_schema_history where success = true", Integer.class);

    assertThat(applied).isNotNull().isGreaterThanOrEqualTo(2);
  }

  @Test
  void anItemRoundTripsExactlyIncludingMicrosecondTimestamps() {
    Account owner = newAccount();
    Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
    Item item = Item.create(owner.id(), "Widget", "round", 5, now);

    Item saved = items.insert(item);
    Item loaded = items.findByIdAndOwner(item.id(), owner.id()).orElseThrow();

    assertThat(loaded).isEqualTo(saved);
    assertThat(loaded.createdAt()).isEqualTo(now);
  }

  @Test
  void lookupsAreScopedToTheOwner() {
    Account alice = newAccount();
    Account bob = newAccount();
    Item mine = items.insert(Item.create(alice.id(), "mine", null, 0, Instant.now()));

    assertThat(items.findByIdAndOwner(mine.id(), bob.id())).isEmpty();
    assertThat(items.deleteByIdAndOwner(mine.id(), bob.id())).isFalse();
    assertThat(items.deleteByIdAndOwner(mine.id(), alice.id())).isTrue();
  }

  @Test
  void aSecondStaleWriteIsRejectedByTheVersionColumn() {
    Account owner = newAccount();
    Item created = items.insert(Item.create(owner.id(), "v0", null, 0, Instant.now()));
    Item first = items.update(created.withDetails("v1", null, 0, Instant.now()));

    assertThat(first.version()).isEqualTo(1);
    // Replays an update loaded at version 0 after version 1 is committed, in one transaction so the
    // stale copy is the managed one: Hibernate's optimistic check must refuse it.
    assertThatThrownBy(
            () ->
                tx.executeWithoutResult(
                    status -> {
                      items.findByIdAndOwner(created.id(), owner.id());
                      new JdbcTemplate(dataSource)
                          .update(
                              "update items set version = version + 1 where id = ?", created.id());
                      items.update(created.withDetails("stale", null, 0, Instant.now()));
                    }))
        .isInstanceOf(org.springframework.dao.OptimisticLockingFailureException.class);
  }

  @Test
  void deletingAnAccountCascadesToItsItems() {
    Account owner = newAccount();
    Item item = items.insert(Item.create(owner.id(), "gone soon", null, 0, Instant.now()));
    var jdbc = new JdbcTemplate(dataSource);

    jdbc.update("delete from accounts where id = ?", owner.id());

    assertThat(items.findByIdAndOwner(item.id(), owner.id())).isEmpty();
  }

  @Test
  void theUniqueIndexOnEmailTurnsARaceIntoAConflict() {
    Account first = newAccount();

    assertThatThrownBy(
            () ->
                accounts.insert(
                    new Account(UUID.randomUUID(), first.email(), "hash", Instant.now())))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void listingNewestFirstUsesTheCreationTimeThenIdAsTheTieBreak() {
    Account owner = newAccount();
    Instant base = Instant.now().truncatedTo(ChronoUnit.MICROS);
    items.insert(Item.create(owner.id(), "old", null, 0, base.minusSeconds(10)));
    items.insert(Item.create(owner.id(), "new", null, 0, base));

    var page = items.findByOwner(owner.id(), null, PageQuery.first());

    assertThat(page.items()).extracting(Item::name).containsExactly("new", "old");
    assertThat(page.nextCursor()).isNull();
  }

  @Test
  void keysetPagingWalksRowsThatShareOneTimestampWithoutRepeatingOrSkipping() {
    Account owner = newAccount();
    Instant same = Instant.now().truncatedTo(ChronoUnit.MICROS);
    Set<UUID> inserted = new HashSet<>();
    for (int i = 0; i < 7; i++) {
      inserted.add(items.insert(Item.create(owner.id(), "tie-" + i, null, 0, same)).id());
    }
    // Two older rows, so the walk crosses from a tie group into distinct timestamps.
    inserted.add(
        items.insert(Item.create(owner.id(), "older-1", null, 0, same.minusSeconds(1))).id());
    inserted.add(
        items.insert(Item.create(owner.id(), "older-2", null, 0, same.minusSeconds(2))).id());

    List<UUID> walked = new ArrayList<>();
    Cursor after = null;
    for (int guard = 0; guard < 20; guard++) {
      var page = items.findByOwner(owner.id(), null, new PageQuery(2, after));
      page.items().forEach(i -> walked.add(i.id()));
      if (page.nextCursor() == null) {
        break;
      }
      after = Cursor.decode(page.nextCursor());
    }

    assertThat(walked)
        .hasSize(9)
        .doesNotHaveDuplicates()
        .containsExactlyInAnyOrderElementsOf(inserted);
    // Newest first, id ascending inside a tie: the order the cursor and the index both use.
    var tied = walked.subList(0, 7);
    // The database orders uuids as unsigned bytes, which is the order of their text form (Java's
    // own
    // UUID.compareTo compares signed longs and would disagree).
    assertThat(tied).isSortedAccordingTo(Comparator.comparing(UUID::toString));
    assertThat(walked.subList(7, 9))
        .extracting(id -> items.findByIdAndOwner(id, owner.id()).orElseThrow().name())
        .containsExactly("older-1", "older-2");
  }

  @Test
  void aCursorFromAnotherOwnersListRevealsNothingOfTheirs() {
    Account alice = newAccount();
    Account bob = newAccount();
    Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
    var bobs = items.insert(Item.create(bob.id(), "bob-secret", null, 0, now));
    items.insert(Item.create(alice.id(), "alice-1", null, 0, now.minusSeconds(5)));

    var page =
        items.findByOwner(
            alice.id(), null, new PageQuery(10, new Cursor(now.plusSeconds(1), bobs.id())));

    assertThat(page.items()).extracting(Item::name).containsExactly("alice-1");
  }

  @Test
  void theSecondMigrationAddedQuantityAndTheActiveFlagWithSafeDefaults() {
    var jdbc = new JdbcTemplate(dataSource);
    Account owner = newAccount();
    Item item = items.insert(Item.create(owner.id(), "counted", null, 42, Instant.now()));

    assertThat(items.findByIdAndOwner(item.id(), owner.id()).orElseThrow().quantity())
        .isEqualTo(42);
    assertThat(accounts.findById(owner.id()).orElseThrow().active()).isTrue();
    assertThat(
            jdbc.queryForObject(
                "select count(*) from flyway_schema_history where success = true and version = '2'",
                Integer.class))
        .isEqualTo(1);
    // The check constraint backs up the domain rule when something bypasses it.
    assertThatThrownBy(() -> jdbc.update("update items set quantity = -1 where id = ?", item.id()))
        .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
  }
}
