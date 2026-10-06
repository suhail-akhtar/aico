package com.example.system.shared.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;

/**
 * Turns on {@code @Async}, which Spring Modulith application-module listeners rely on: they run
 * after the publishing transaction commits, on their own thread (a virtual one, see {@code
 * spring.threads.virtual.enabled}), so a slow mail server never slows a request down.
 */
@Configuration(proxyBeanMethods = false)
@EnableAsync
class AsyncConfig {}
