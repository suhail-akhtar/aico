/**
 * Audit: an append-only record of who did what. It listens to the tasks module's published events
 * and writes one row per event in the same transaction as the change, so there is no committed
 * change without its audit row and no audit row for a change that rolled back. The table refuses
 * UPDATE, DELETE and TRUNCATE at the database level (see the migration), so even a bug in this
 * application cannot rewrite history.
 */
@ApplicationModule(
    displayName = "Audit",
    allowedDependencies = {"tasks::events", "shared"})
package com.example.system.audit;

import org.springframework.modulith.ApplicationModule;
