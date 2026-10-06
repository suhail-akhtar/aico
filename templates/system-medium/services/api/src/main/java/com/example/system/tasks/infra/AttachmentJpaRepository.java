package com.example.system.tasks.infra;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data repository for attachment metadata; package-private like the task one. */
interface AttachmentJpaRepository extends JpaRepository<AttachmentEntity, UUID> {

  List<AttachmentEntity> findByTaskIdOrderByCreatedAtAsc(UUID taskId);

  Optional<AttachmentEntity> findByIdAndTaskId(UUID id, UUID taskId);

  long countByTaskId(UUID taskId);

  long deleteByIdAndTaskId(UUID id, UUID taskId);
}
