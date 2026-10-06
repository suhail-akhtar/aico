/**
 * Shared kernel: errors, paging, configuration, web plumbing and security wiring that every feature
 * may use. It never depends on a feature, which Spring Modulith and ArchUnit verify.
 */
@ApplicationModule(type = ApplicationModule.Type.OPEN)
package com.example.app.shared;

import org.springframework.modulith.ApplicationModule;
