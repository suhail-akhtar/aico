package com.example.system.tasks.api;

import com.example.system.shared.page.PageQuery;
import com.example.system.shared.page.PageResult;
import com.example.system.tasks.app.TaskService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The one place a caller sees other people's tasks, restricted to the ADMIN role twice: by the URL
 * rule in the security configuration and by method security here, so removing either alone does not
 * open it.
 */
@RestController
@RequestMapping("/api/v1/admin/tasks")
public class AdminTaskController {

  private final TaskService service;

  public AdminTaskController(TaskService service) {
    this.service = service;
  }

  @Operation(summary = "List every task, whoever owns it (administrators only)")
  @ApiResponse(responseCode = "403", description = "The caller is not an administrator")
  @PreAuthorize("hasRole('ADMIN')")
  @GetMapping
  public PageResult<TaskResponse> listAll(
      @RequestParam(defaultValue = "0") @Min(0) int page,
      @RequestParam(defaultValue = "20") @Min(1) @Max(PageQuery.MAX_SIZE) int size) {
    return service.listAll(new PageQuery(page, size)).map(TaskResponse::from);
  }
}
