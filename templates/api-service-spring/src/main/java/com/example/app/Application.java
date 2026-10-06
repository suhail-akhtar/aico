package com.example.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Composition root: Spring scans the feature packages below this one ({@code identity}, {@code
 * items}) and the shared kernel ({@code shared}). Features never import each other; they meet only
 * here, through the container.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class Application {

  public static void main(String[] args) {
    SpringApplication.run(Application.class, args);
  }
}
