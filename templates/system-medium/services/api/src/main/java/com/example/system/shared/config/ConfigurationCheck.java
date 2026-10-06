package com.example.system.shared.config;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.ValidatorFactory;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.boot.context.properties.bind.BindException;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.EnvironmentAware;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.PriorityOrdered;
import org.springframework.core.env.Environment;

/**
 * Stops the application, before any bean is built, when configuration is missing or unacceptable,
 * with a message that names the environment variable to fix.
 *
 * <p>Two reasons it exists. Without it a missing {@code DATABASE_URL} surfaces as "'url' must start
 * with jdbc" from deep inside the datasource, and a weak {@code APP_JWT_SECRET} is only noticed
 * after Flyway has already connected to the database. And Spring Boot's own binding failure report
 * prints the rejected value, which for a secret means writing it to the log; this check reports the
 * setting and the rule, never the value.
 *
 * <p>It is a bean factory post-processor rather than an environment post-processor so that values
 * supplied late (test properties, container-provided ones) are already visible. The rules
 * themselves are the annotations on {@link AppProperties}: one rule set, checked here first.
 */
@Configuration(proxyBeanMethods = false)
class ConfigurationCheck {

  /** Property to check -> the environment variable an operator sets to provide it. */
  private static final Map<String, String> REQUIRED = new LinkedHashMap<>();

  static {
    REQUIRED.put("spring.datasource.url", "DATABASE_URL");
    REQUIRED.put("spring.datasource.username", "DATABASE_USER");
    REQUIRED.put("spring.datasource.password", "DATABASE_PASSWORD");
    REQUIRED.put("spring.security.oauth2.client.provider.keycloak.issuer-uri", "OIDC_ISSUER_URI");
    REQUIRED.put(
        "spring.security.oauth2.client.registration.keycloak.client-secret", "OIDC_CLIENT_SECRET");
    REQUIRED.put("spring.data.redis.host", "VALKEY_HOST");
  }

  @Bean
  static Check startupCheck() {
    return new Check();
  }

  /** The post-processor. Static and separate so it exists before the configuration beans. */
  static final class Check implements BeanFactoryPostProcessor, EnvironmentAware, PriorityOrdered {

    private @Nullable Environment environment;

    @Override
    public void setEnvironment(Environment environment) {
      this.environment = environment;
    }

    @Override
    public int getOrder() {
      return Ordered.HIGHEST_PRECEDENCE;
    }

    @Override
    public void postProcessBeanFactory(ConfigurableListableBeanFactory beanFactory)
        throws BeansException {
      List<String> problems = problems(Objects.requireNonNull(environment));
      if (!problems.isEmpty()) {
        throw new InvalidConfigurationException(problems);
      }
    }
  }

  /** Every problem with the configuration, missing values first, in a stable order. */
  static List<String> problems(Environment environment) {
    List<String> problems = new ArrayList<>();
    REQUIRED.forEach(
        (property, variable) -> {
          String value;
          try {
            value = environment.getProperty(property);
          } catch (IllegalArgumentException unresolvedPlaceholder) {
            value = null;
          }
          if (value == null || value.isBlank()) {
            problems.add(variable + " is not set");
          }
        });
    if (!problems.isEmpty()) {
      return problems;
    }
    try (ValidatorFactory factory = Validation.buildDefaultValidatorFactory()) {
      AppProperties properties =
          Binder.get(environment).bind("app", Bindable.of(AppProperties.class)).orElse(null);
      if (properties != null) {
        for (ConstraintViolation<AppProperties> violation :
            factory.getValidator().validate(properties)) {
          problems.add(violation.getPropertyPath() + ": " + violation.getMessage());
        }
      }
    } catch (BindException e) {
      problems.add(
          e.getName() + " has a value of the wrong kind (" + e.getTarget().getType() + ")");
    }
    problems.sort(String::compareTo);
    return problems;
  }
}
