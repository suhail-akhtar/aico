package com.example.system.tasks.api;

import com.example.system.tasks.domain.Task;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.jspecify.annotations.Nullable;

/**
 * Body of create and update. Bean Validation catches the shape (missing, too long) at the edge for
 * a clear 400; the domain {@link Task} re-checks the same rules plus the ones that need code, so a
 * rule cannot be bypassed by calling the service from somewhere else. {@code version} is the
 * optimistic-lock guard on update: send the version you last read.
 */
public record TaskRequest(
    @NotBlank @Size(max = Task.TITLE_MAX) String title,
    @Size(max = Task.DESCRIPTION_MAX) @Nullable String description,
    @Size(max = Task.EMAIL_MAX) @Nullable String assigneeEmail,
    @Nullable Long version) {}
