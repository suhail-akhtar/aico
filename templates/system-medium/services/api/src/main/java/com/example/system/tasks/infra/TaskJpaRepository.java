package com.example.system.tasks.infra;

import com.example.system.tasks.domain.TaskStatus;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

/**
 * Spring Data repository. Package-private on purpose: only {@link TaskRepositoryAdapter} may use
 * it, so the domain port stays the only way in. Derived queries bind parameters, so a search string
 * is data, never SQL; Spring Data also escapes {@code %} and {@code _} in "contains".
 */
interface TaskJpaRepository extends JpaRepository<TaskEntity, UUID> {

  Optional<TaskEntity> findByIdAndOwnerId(UUID id, UUID ownerId);

  Page<TaskEntity> findByOwnerId(UUID ownerId, Pageable pageable);

  Page<TaskEntity> findByOwnerIdAndStatus(UUID ownerId, TaskStatus status, Pageable pageable);

  Page<TaskEntity> findByOwnerIdAndTitleContainingIgnoreCase(
      UUID ownerId, String title, Pageable pageable);

  Page<TaskEntity> findByOwnerIdAndStatusAndTitleContainingIgnoreCase(
      UUID ownerId, TaskStatus status, String title, Pageable pageable);

  long deleteByIdAndOwnerId(UUID id, UUID ownerId);

  long countByOwnerIdAndStatus(UUID ownerId, TaskStatus status);
}
