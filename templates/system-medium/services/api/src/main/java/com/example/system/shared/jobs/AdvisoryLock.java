package com.example.system.shared.jobs;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * A cluster-wide "only one runs this" lock built on PostgreSQL advisory locks, so scheduled work
 * stays single-run when more than one worker replica is up, without adding a scheduler library. The
 * lock is transaction-scoped: it is released when the transaction ends, even if the process dies,
 * so a crashed worker cannot hold it forever. A replica that does not get the lock simply skips
 * this round.
 */
@Component
class AdvisoryLock {

  private final JdbcClient jdbc;
  private final TransactionTemplate transaction;

  AdvisoryLock(JdbcClient jdbc, TransactionTemplate transaction) {
    this.jdbc = jdbc;
    this.transaction = transaction;
  }

  /** Runs {@code work} if this replica wins the lock named {@code name}; returns whether it ran. */
  boolean runExclusively(String name, Runnable work) {
    return Boolean.TRUE.equals(
        transaction.execute(
            status -> {
              Boolean acquired =
                  jdbc.sql("select pg_try_advisory_xact_lock(hashtext(:name))")
                      .param("name", name)
                      .query(Boolean.class)
                      .single();
              if (!Boolean.TRUE.equals(acquired)) {
                return false;
              }
              work.run();
              return true;
            }));
  }
}
