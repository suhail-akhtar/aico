package com.example.system;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Composition root. Spring scans the application modules below this package ({@code identity},
 * {@code tasks}, {@code notifications}, {@code audit}) and the shared kernel ({@code shared}).
 * Modules never import each other's internals; they meet through published events, the few public
 * types in a module's root package, and this container (Spring Modulith verifies it).
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class Application {

  public static void main(String[] args) {
    SpringApplication.run(Application.class, args);
  }
}
