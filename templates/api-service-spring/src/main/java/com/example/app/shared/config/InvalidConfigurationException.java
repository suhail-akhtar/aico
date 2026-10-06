package com.example.app.shared.config;

import java.util.List;

/**
 * Startup failed because required settings are missing or unacceptable. Each problem names the
 * setting and the rule it broke; none ever contains the offending value, so a weak secret is not
 * copied into the logs by the failure report.
 */
public class InvalidConfigurationException extends IllegalStateException {

  private static final long serialVersionUID = 1L;

  private final transient List<String> problems;

  public InvalidConfigurationException(List<String> problems) {
    super("Invalid configuration: " + String.join("; ", problems));
    this.problems = List.copyOf(problems);
  }

  public List<String> problems() {
    return problems;
  }
}
