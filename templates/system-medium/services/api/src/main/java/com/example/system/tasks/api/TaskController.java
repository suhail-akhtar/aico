package com.example.system.tasks.api;

import com.example.system.identity.AuthenticatedUser;
import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import com.example.system.tasks.app.TaskService;
import com.example.system.tasks.domain.TaskStatus;
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
 * HTTP edge of the tasks feature: parse, validate, call the service, shape the response. No
 * business rule lives here. The caller comes from the verified credential, never from the request.
 */
@RestController
@RequestMapping("/api/v1/tasks")
public class TaskController {

  private final TaskService service;

  public TaskController(TaskService service) {
    this.service = service;
  }

  @Operation(summary = "Create a task owned by the caller")
  @ApiResponse(responseCode = "201", description = "Created")
  @ApiResponse(responseCode = "409", description = "The caller has too many open tasks")
  @PostMapping
  public ResponseEntity<TaskResponse> create(@Valid @RequestBody TaskRequest request) {
    var task =
        service.create(
            AuthenticatedUser.current(),
            request.title(),
            request.description(),
            request.assigneeEmail());
    return ResponseEntity.created(URI.create("/api/v1/tasks/" + task.id()))
        .body(TaskResponse.from(task));
  }

  @Operation(summary = "List the caller's tasks, newest first")
  @GetMapping
  public PageResult<TaskResponse> list(
      @RequestParam(defaultValue = "0") @Min(0) int page,
      @RequestParam(defaultValue = "20") @Min(1) @Max(PageQuery.MAX_SIZE) int size,
      @RequestParam(required = false) @Nullable TaskStatus status,
      @RequestParam(required = false)
          @Size(max = 100)
          @Pattern(regexp = "^[^\\p{Cntrl}]*$", message = "must not contain control characters")
          @Nullable String q) {
    return service
        .list(AuthenticatedUser.current(), status, q, new PageQuery(page, size))
        .map(TaskResponse::from);
  }

  @Operation(summary = "Get one of the caller's tasks")
  @GetMapping("/{id}")
  public TaskResponse get(@PathVariable UUID id) {
    return TaskResponse.from(service.get(AuthenticatedUser.current(), id));
  }

  @Operation(summary = "Replace the content of one of the caller's tasks")
  @ApiResponse(responseCode = "409", description = "The task changed since the supplied version")
  @PutMapping("/{id}")
  public TaskResponse update(@PathVariable UUID id, @Valid @RequestBody TaskRequest request) {
    return TaskResponse.from(
        service.update(
            AuthenticatedUser.current(),
            id,
            request.title(),
            request.description(),
            request.assigneeEmail(),
            request.version()));
  }

  @Operation(summary = "Mark one of the caller's tasks done (idempotent)")
  @PostMapping("/{id}/complete")
  public TaskResponse complete(@PathVariable UUID id) {
    return TaskResponse.from(service.complete(AuthenticatedUser.current(), id));
  }

  @Operation(summary = "Delete one of the caller's tasks and its attachments")
  @ApiResponse(responseCode = "204", description = "Deleted")
  @DeleteMapping("/{id}")
  public ResponseEntity<Void> delete(@PathVariable UUID id) {
    service.delete(AuthenticatedUser.current(), id);
    return ResponseEntity.noContent().build();
  }
}
