package com.example.system.shared.storage;

import com.example.system.shared.config.AppProperties;
import java.net.URI;
import java.time.Duration;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;

/**
 * Builds the S3 client and store. Checksums are calculated only when an operation requires one: the
 * SDK's default (always add a CRC trailer) is rejected by several S3-compatible servers, and the
 * store's own integrity checks already cover the transfer. Timeouts are explicit so a stalled store
 * cannot hold a request thread forever.
 */
@Configuration(proxyBeanMethods = false)
class StorageConfig {

  private static final Logger LOG = LoggerFactory.getLogger(StorageConfig.class);

  @Bean
  @ConditionalOnProperty(name = "app.storage.provider", havingValue = "s3", matchIfMissing = true)
  ObjectStore objectStore(AppProperties props) {
    AppProperties.Storage cfg = props.storage();
    S3Client client =
        S3Client.builder()
            .endpointOverride(URI.create(Objects.requireNonNull(cfg.endpoint())))
            .region(Region.of(cfg.region()))
            .credentialsProvider(
                StaticCredentialsProvider.create(
                    AwsBasicCredentials.create(
                        Objects.requireNonNull(cfg.accessKey()),
                        Objects.requireNonNull(cfg.secretKey()))))
            .serviceConfiguration(
                S3Configuration.builder().pathStyleAccessEnabled(cfg.pathStyle()).build())
            .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
            .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
            .httpClientBuilder(
                UrlConnectionHttpClient.builder()
                    .connectionTimeout(Duration.ofSeconds(3))
                    .socketTimeout(Duration.ofSeconds(30)))
            .build();
    S3ObjectStore store = new S3ObjectStore(client, cfg.bucket());
    if (cfg.createBucket()) {
      try {
        store.ensureBucket();
      } catch (RuntimeException e) {
        // Storage is not needed to serve most requests: start anyway, and let uploads answer 503
        // until the store is reachable instead of crash-looping the whole API.
        LOG.warn("Could not create the bucket at startup: {}", e.getClass().getSimpleName());
      }
    }
    return store;
  }
}
