/**
 * Notifications: tells people about what happened by email. It listens to the tasks module's
 * published events and knows nothing else about tasks. Delivery is at-least-once (the outbox
 * retries a failed handler) and handling is idempotent (the inbox remembers what was already done),
 * so a retry never sends a second email for the same event.
 */
@ApplicationModule(
    displayName = "Notifications",
    allowedDependencies = {"tasks::events", "shared"})
package com.example.system.notifications;

import org.springframework.modulith.ApplicationModule;
