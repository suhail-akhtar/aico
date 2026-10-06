package com.example.system.tasks.infra;

import com.example.system.tasks.domain.Attachment;
import com.example.system.tasks.domain.AttachmentRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/** Adapter: implements the domain port {@link AttachmentRepository} with Spring Data JPA. */
@Repository
class AttachmentRepositoryAdapter implements AttachmentRepository {

  private final AttachmentJpaRepository jpa;

  AttachmentRepositoryAdapter(AttachmentJpaRepository jpa) {
    this.jpa = jpa;
  }

  @Override
  public Attachment insert(Attachment a) {
    return toDomain(
        jpa.saveAndFlush(
            new AttachmentEntity(
                a.id(),
                a.taskId(),
                a.fileName(),
                a.contentType(),
                a.sizeBytes(),
                a.objectKey(),
                a.createdAt())));
  }

  @Override
  public List<Attachment> findByTask(UUID taskId) {
    return jpa.findByTaskIdOrderByCreatedAtAsc(taskId).stream()
        .map(AttachmentRepositoryAdapter::toDomain)
        .toList();
  }

  @Override
  public Optional<Attachment> findByIdAndTask(UUID id, UUID taskId) {
    return jpa.findByIdAndTaskId(id, taskId).map(AttachmentRepositoryAdapter::toDomain);
  }

  @Override
  public long countByTask(UUID taskId) {
    return jpa.countByTaskId(taskId);
  }

  @Override
  @Transactional
  public boolean deleteByIdAndTask(UUID id, UUID taskId) {
    return jpa.deleteByIdAndTaskId(id, taskId) > 0;
  }

  private static Attachment toDomain(AttachmentEntity e) {
    return new Attachment(
        e.getId(),
        e.getTaskId(),
        e.getFileName(),
        e.getContentType(),
        e.getSizeBytes(),
        e.getObjectKey(),
        e.getCreatedAt());
  }
}
