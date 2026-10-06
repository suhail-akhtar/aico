package com.example.app.items.api;

import com.example.app.items.app.ItemService;
import com.example.app.shared.page.Cursor;
import com.example.app.shared.page.CursorPage;
import com.example.app.shared.page.PageQuery;
import com.example.app.shared.security.AuthenticatedUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * HTTP edge of the items feature: parse, validate, call the service, shape the response. No
 * business rule lives here. The caller's id comes from the verified token.
 */
@RestController
@RequestMapping("/api/v1/items")
public class ItemController {

  private final ItemService service;

  public ItemController(ItemService service) {
    this.service = service;
  }

  @Operation(summary = "Create an item owned by the caller")
  @ApiResponse(responseCode = "201", description = "Created")
  @PostMapping
  public ResponseEntity<ItemResponse> create(
      @AuthenticationPrincipal Jwt jwt, @Valid @RequestBody ItemRequest request) {
    var item =
        service.create(
            AuthenticatedUser.id(jwt),
            request.name(),
            request.description(),
            request.quantityOrDefault());
    return ResponseEntity.created(URI.create("/api/v1/items/" + item.id()))
        .body(ItemResponse.from(item));
  }

  @Operation(
      summary = "List the caller's items, newest first",
      description =
          "Keyset paging: pass the previous response's next_cursor as cursor to get the next page."
              + " next_cursor is null on the last page. Cursors are opaque; do not build them.")
  @GetMapping
  public CursorPage<ItemResponse> list(
      @AuthenticationPrincipal Jwt jwt,
      @RequestParam(defaultValue = "" + PageQuery.DEFAULT_LIMIT) @Min(1) @Max(PageQuery.MAX_LIMIT)
          int limit,
      @RequestParam(required = false) @Size(max = 200) @Nullable String cursor,
      @RequestParam(required = false)
          @Size(max = 100)
          @Pattern(regexp = "^[^\\p{Cntrl}]*$", message = "must not contain control characters")
          @Nullable String q) {
    Cursor after = cursor == null || cursor.isEmpty() ? null : Cursor.decode(cursor);
    return service
        .list(AuthenticatedUser.id(jwt), q, new PageQuery(limit, after))
        .map(ItemResponse::from);
  }

  @Operation(summary = "Get one of the caller's items")
  @GetMapping("/{id}")
  public ItemResponse get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
    return ItemResponse.from(service.get(AuthenticatedUser.id(jwt), id));
  }

  @Operation(summary = "Replace the content of one of the caller's items")
  @ApiResponse(responseCode = "409", description = "The item changed since the supplied version")
  @PutMapping("/{id}")
  public ItemResponse update(
      @AuthenticationPrincipal Jwt jwt,
      @PathVariable UUID id,
      @Valid @RequestBody ItemRequest request) {
    return ItemResponse.from(
        service.update(
            AuthenticatedUser.id(jwt),
            id,
            request.name(),
            request.description(),
            request.quantityOrDefault(),
            request.version()));
  }

  @Operation(summary = "Delete one of the caller's items")
  @ApiResponse(responseCode = "204", description = "Deleted")
  @DeleteMapping("/{id}")
  public ResponseEntity<Void> delete(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
    service.delete(AuthenticatedUser.id(jwt), id);
    return ResponseEntity.noContent().build();
  }
}
