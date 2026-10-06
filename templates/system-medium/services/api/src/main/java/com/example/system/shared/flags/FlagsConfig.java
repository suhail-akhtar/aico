package com.example.system.shared.flags;

import com.example.system.shared.config.AppProperties;
import dev.openfeature.contrib.providers.flagd.Config;
import dev.openfeature.contrib.providers.flagd.FlagdOptions;
import dev.openfeature.contrib.providers.flagd.FlagdProvider;
import dev.openfeature.sdk.FeatureProvider;
import dev.openfeature.sdk.OpenFeatureAPI;
import dev.openfeature.sdk.providers.memory.Flag;
import dev.openfeature.sdk.providers.memory.InMemoryProvider;
import java.util.HashMap;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Chooses the OpenFeature provider once at startup. {@code flagd} talks to the flagd sidecar over
 * gRPC; it is registered without waiting, so the API starts (and keeps serving, on code defaults)
 * even when flagd is not up yet. {@code memory} serves {@link FeatureFlags#DEFAULTS}, for tests and
 * for running with no flag service at all.
 */
@Configuration(proxyBeanMethods = false)
class FlagsConfig {

  @Bean
  FeatureFlags featureFlags(AppProperties props) {
    OpenFeatureAPI api = OpenFeatureAPI.getInstance();
    AppProperties.Flags flags = props.flags();
    FeatureProvider provider = "flagd".equals(flags.provider()) ? flagd(flags) : memory();
    api.setProvider(provider);
    return new FeatureFlags(api.getClient("system-api"));
  }

  private static FeatureProvider flagd(AppProperties.Flags flags) {
    return new FlagdProvider(
        FlagdOptions.builder()
            .resolverType(Config.Resolver.RPC)
            .host(flags.flagdHost())
            .port(flags.flagdPort())
            .deadline(500)
            .build());
  }

  private static FeatureProvider memory() {
    Map<String, Flag<?>> flags = new HashMap<>();
    FeatureFlags.DEFAULTS.forEach(
        (key, value) ->
            flags.put(
                key, Flag.builder().variant("default", value).defaultVariant("default").build()));
    return new InMemoryProvider(flags);
  }
}
