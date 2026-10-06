package com.example.app.shared.config;

import java.util.stream.Collectors;
import org.springframework.boot.diagnostics.AbstractFailureAnalyzer;
import org.springframework.boot.diagnostics.FailureAnalysis;

/** Turns {@link InvalidConfigurationException} into Spring Boot's "failed to start" report. */
class InvalidConfigurationAnalyzer extends AbstractFailureAnalyzer<InvalidConfigurationException> {

  @Override
  protected FailureAnalysis analyze(Throwable rootFailure, InvalidConfigurationException cause) {
    String list =
        cause.problems().stream()
            .map(problem -> "  - " + problem)
            .collect(Collectors.joining("\n"));
    return new FailureAnalysis(
        "The application is not configured correctly:\n" + list,
        "Set the variables in the environment, or in .env.local (copy .env.example, or run"
            + " `make setup`). Nothing is read from anywhere else.",
        cause);
  }
}
