/**
 * Tasks: the worked feature. A user creates tasks, assigns them by email, completes them and
 * attaches files. Every state change publishes an event inside the same transaction (see {@link
 * com.example.system.tasks.domain.event}); other modules react to the events and never to this
 * module's tables or classes. Copy this package to add a feature.
 */
@ApplicationModule(
    displayName = "Tasks",
    allowedDependencies = {"identity", "shared"})
package com.example.system.tasks;

import org.springframework.modulith.ApplicationModule;
