package com.example.system.shared.flags;

import dev.openfeature.sdk.Client;
import dev.openfeature.sdk.EvaluationContext;
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.Value;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The application's view of feature flags. Code asks this class, never a provider: the OpenFeature
 * API is the contract, flagd is today's provider, and a different one (Unleash, a SaaS) is a
 * configuration change.
 *
 * <p>Every flag has a default in code. If the provider is down or the flag is missing, the default
 * answers and the request carries on: a flag service outage must degrade behaviour, not
 * availability. Flags are for rollout and kill switches, not for secrets or authorisation
 * decisions.
 */
public final class FeatureFlags {

  public static final String ATTACHMENTS_ENABLED = "attachments-enabled";
  public static final String MAX_OPEN_TASKS_PER_USER = "max-open-tasks-per-user";
  public static final String EMAIL_NOTIFICATIONS_ENABLED = "email-notifications-enabled";

  /** The values used when no provider answers (and by the in-memory provider in tests). */
  public static final Map<String, Object> DEFAULTS =
      Map.of(
          ATTACHMENTS_ENABLED, true,
          MAX_OPEN_TASKS_PER_USER, 100,
          EMAIL_NOTIFICATIONS_ENABLED, true);

  private final Client client;

  public FeatureFlags(Client client) {
    this.client = client;
  }

  public boolean enabled(String flag, EvaluationContext context) {
    return client.getBooleanValue(
        flag, (Boolean) DEFAULTS.getOrDefault(flag, Boolean.FALSE), context);
  }

  public int number(String flag, EvaluationContext context) {
    return client.getIntegerValue(flag, (Integer) DEFAULTS.getOrDefault(flag, 0), context);
  }

  /** A context whose targeting key is the user, so a rule can target one person or a role. */
  public static EvaluationContext contextFor(
      @Nullable String userId, @Nullable String email, Collection<String> roles) {
    Map<String, Value> attributes = new HashMap<>();
    if (email != null) {
      attributes.put("email", new Value(email));
    }
    attributes.put("roles", new Value(roles.stream().map(Value::new).toList()));
    return new ImmutableContext(userId == null ? "anonymous" : userId, attributes);
  }

  /** What the client application may know about the flags: the evaluated values for a user. */
  public Map<String, Object> snapshot(EvaluationContext context) {
    return Map.of(
        "attachmentsEnabled", enabled(ATTACHMENTS_ENABLED, context),
        "maxOpenTasksPerUser", number(MAX_OPEN_TASKS_PER_USER, context),
        "emailNotificationsEnabled", enabled(EMAIL_NOTIFICATIONS_ENABLED, context));
  }
}
