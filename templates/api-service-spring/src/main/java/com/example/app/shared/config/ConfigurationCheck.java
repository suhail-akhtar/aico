package com.example.app.shared.config;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.ValidatorFactory;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
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

  private static final Pattern NAMES_A_VARIABLE = Pattern.compile("^[A-Z][A-Z0-9]*_[A-Z0-9_]+ ");

  /** Property to check -> the environment variable an operator sets to provide it. */
  private static final Map<String, String> ALWAYS_REQUIRED = new LinkedHashMap<>();

  /** Only in {@code APP_AUTH_MODE=local}: the key the local issuer signs with. */
  private static final Map<String, String> LOCAL_REQUIRED =
      Map.of("app.jwt.secret", "APP_JWT_SECRET");

  /** Only in {@code APP_AUTH_MODE=oidc}: where tokens come from and how to check them. */
  private static final Map<String, String> OIDC_REQUIRED = new LinkedHashMap<>();

  static {
    ALWAYS_REQUIRED.put("spring.datasource.url", "DATABASE_URL");
    ALWAYS_REQUIRED.put("spring.datasource.username", "DATABASE_USER");
    OIDC_REQUIRED.put("app.auth.oidc.issuer", "OIDC_ISSUER");
    OIDC_REQUIRED.put("app.auth.oidc.jwks-uri", "OIDC_JWKS_URI");
    OIDC_REQUIRED.put("app.auth.oidc.audience", "OIDC_AUDIENCE");
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
    String mode = valueOf(environment, "app.auth.mode");
    boolean oidc = mode != null && !mode.isBlank() && mode.strip().equalsIgnoreCase("oidc");
    if (mode != null && !mode.isBlank() && !oidc && !mode.strip().equalsIgnoreCase("local")) {
      // Never echo the value: the mode is not secret, but the habit keeps the rule simple.
      problems.add("APP_AUTH_MODE must be local or oidc");
    }
    collectMissing(environment, ALWAYS_REQUIRED, problems);
    collectMissing(environment, oidc ? OIDC_REQUIRED : LOCAL_REQUIRED, problems);
    if (!problems.isEmpty()) {
      return problems;
    }
    try (ValidatorFactory factory = Validation.buildDefaultValidatorFactory()) {
      AppProperties properties =
          Binder.get(environment).bind("app", Bindable.of(AppProperties.class)).orElse(null);
      if (properties != null) {
        for (ConstraintViolation<AppProperties> violation :
            factory.getValidator().validate(properties)) {
          String path = violation.getPropertyPath().toString();
          String message = violation.getMessage();
          // A message that already starts with the variable to fix ("OIDC_ISSUER is required ...")
          // says everything; any other rule is clearer with the setting's path in front.
          problems.add(NAMES_A_VARIABLE.matcher(message).find() ? message : path + ": " + message);
        }
      }
    } catch (BindException e) {
      problems.add(
          e.getName() + " has a value of the wrong kind (" + e.getTarget().getType() + ")");
    }
    problems.sort(String::compareTo);
    return problems;
  }

  private static void collectMissing(
      Environment environment, Map<String, String> required, List<String> problems) {
    required.forEach(
        (property, variable) -> {
          String value = valueOf(environment, property);
          if (value == null || value.isBlank()) {
            problems.add(variable + " is not set");
          }
        });
  }

  private static @Nullable String valueOf(Environment environment, String property) {
    try {
      return environment.getProperty(property);
    } catch (IllegalArgumentException unresolvedPlaceholder) {
      return null;
    }
  }
}
