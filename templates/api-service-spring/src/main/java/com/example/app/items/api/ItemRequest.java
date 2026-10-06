package com.example.app.items.api;

import com.example.app.items.domain.Item;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.jspecify.annotations.Nullable;

/**
 * Body of create and update (update is a full replace: an omitted {@code quantity} becomes 0, like
 * on create). {@code version} is optional on update: send the version you last read and a
 * concurrent change is reported as 409 rather than overwritten. Bean Validation gives the caller
 * field-level messages; the domain checks the same limits again as a backstop.
 */
public record ItemRequest(
    @NotBlank @Size(max = Item.NAME_MAX) String name,
    @Size(max = Item.DESCRIPTION_MAX) @Nullable String description,
    @Min(0) @Max(Item.QUANTITY_MAX) @Nullable Integer quantity,
    @Nullable Long version) {

  /** The quantity to store: what the caller sent, or 0. */
  public int quantityOrDefault() {
    return quantity == null ? 0 : quantity;
  }
}
