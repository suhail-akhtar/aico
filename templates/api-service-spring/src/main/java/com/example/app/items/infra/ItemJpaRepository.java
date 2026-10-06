package com.example.app.items.infra;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

/**
 * Spring Data repository. Package-private on purpose: only {@link ItemRepositoryAdapter} may use
 * it, so the domain port stays the only way in. Derived queries and specifications bind parameters,
 * so a search string or cursor is data, never SQL. The list query is a {@link
 * org.springframework.data.jpa.domain.Specification} because it combines an optional name filter
 * with an optional keyset position, which four derived-query variants would only spell out.
 */
interface ItemJpaRepository
    extends JpaRepository<ItemEntity, UUID>, JpaSpecificationExecutor<ItemEntity> {

  Optional<ItemEntity> findByIdAndOwnerId(UUID id, UUID ownerId);

  long deleteByIdAndOwnerId(UUID id, UUID ownerId);
}
