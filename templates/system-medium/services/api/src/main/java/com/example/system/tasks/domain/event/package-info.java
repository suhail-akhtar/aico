/**
 * The events the tasks module publishes: its published language. They are the only part of the
 * module that other modules may depend on, which is declared with a named interface so Spring
 * Modulith enforces it.
 */
@NamedInterface("events")
package com.example.system.tasks.domain.event;

import org.springframework.modulith.NamedInterface;
