package com.example.app.items;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.app.items.domain.Item;
import com.example.app.shared.error.ValidationException;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ItemTest {

  private static final Instant NOW = Instant.parse("2026-10-06T10:00:00Z");
  private static final UUID OWNER = UUID.randomUUID();

  @Test
  void createTrimsTheNameAndStartsAtVersionZero() {
    Item item = Item.create(OWNER, "  Widget  ", "a thing", 3, NOW);

    assertThat(item.name()).isEqualTo("Widget");
    assertThat(item.ownerId()).isEqualTo(OWNER);
    assertThat(item.createdAt()).isEqualTo(NOW).isEqualTo(item.updatedAt());
    assertThat(item.version()).isZero();
    assertThat(item.quantity()).isEqualTo(3);
  }

  @Test
  void quantityMustBeBetweenZeroAndTheMaximum() {
    assertThat(Item.create(OWNER, "ok", null, 0, NOW).quantity()).isZero();
    assertThat(Item.create(OWNER, "ok", null, Item.QUANTITY_MAX, NOW).quantity())
        .isEqualTo(Item.QUANTITY_MAX);
    assertThatThrownBy(() -> Item.create(OWNER, "ok", null, -1, NOW))
        .isInstanceOfSatisfying(
            ValidationException.class,
            e ->
                assertThat(e.violations())
                    .singleElement()
                    .satisfies(v -> assertThat(v.field()).isEqualTo("quantity")));
    assertThatThrownBy(() -> Item.create(OWNER, "ok", null, Item.QUANTITY_MAX + 1, NOW))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void blankNameIsRejectedWithTheFieldNamed() {
    assertThatThrownBy(() -> Item.create(OWNER, "   ", null, 0, NOW))
        .isInstanceOfSatisfying(
            ValidationException.class,
            e ->
                assertThat(e.violations())
                    .singleElement()
                    .satisfies(v -> assertThat(v.field()).isEqualTo("name")));
  }

  @Test
  void everyBrokenRuleIsReportedAtOnce() {
    String tooLong = "x".repeat(Item.DESCRIPTION_MAX + 1);

    assertThatThrownBy(() -> Item.create(OWNER, "", tooLong, 0, NOW))
        .isInstanceOfSatisfying(
            ValidationException.class, e -> assertThat(e.violations()).hasSize(2));
  }

  @Test
  void nameAtTheLimitIsAcceptedAndOneOverIsNot() {
    assertThat(Item.create(OWNER, "n".repeat(Item.NAME_MAX), null, 0, NOW)).isNotNull();
    assertThatThrownBy(() -> Item.create(OWNER, "n".repeat(Item.NAME_MAX + 1), null, 0, NOW))
        .isInstanceOf(ValidationException.class);
  }

  @Test
  void withDetailsKeepsIdentityAndCreationTimeButMovesTheModifiedTime() {
    Item item = Item.create(OWNER, "Widget", null, 1, NOW);
    Instant later = NOW.plusSeconds(60);

    Item changed = item.withDetails("Gadget", "new", 9, later);

    assertThat(changed.id()).isEqualTo(item.id());
    assertThat(changed.createdAt()).isEqualTo(NOW);
    assertThat(changed.updatedAt()).isEqualTo(later);
    assertThat(changed.name()).isEqualTo("Gadget");
    assertThat(changed.quantity()).isEqualTo(9);
  }
}
