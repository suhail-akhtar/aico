package com.example.system.support;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/**
 * Replaces the things that live outside the process: the identity provider (a static client
 * registration and a token decoder with a throwaway key, so nothing is discovered over the
 * network), SMTP (a recorder) and object storage (a map). Everything else, PostgreSQL and Valkey
 * included, is real.
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestBeans {

  @Bean
  ClientRegistrationRepository clientRegistrationRepository() {
    ClientRegistration keycloak =
        ClientRegistration.withRegistrationId("keycloak")
            .clientId("system-web")
            .clientSecret("test-only-fake-client-secret")
            .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
            .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
            .redirectUri("{baseUrl}/login/oauth2/code/{registrationId}")
            .scope("openid", "profile", "email")
            .authorizationUri("http://idp.test/realms/app/protocol/openid-connect/auth")
            .tokenUri("http://idp.test/realms/app/protocol/openid-connect/token")
            .jwkSetUri("http://idp.test/realms/app/protocol/openid-connect/certs")
            .userInfoUri("http://idp.test/realms/app/protocol/openid-connect/userinfo")
            .userNameAttributeName("sub")
            .issuerUri("http://idp.test/realms/app")
            .build();
    return new InMemoryClientRegistrationRepository(keycloak);
  }

  /** Tokens are signed with a throwaway key; the validation rules are the production ones. */
  @Bean
  @Primary
  JwtDecoder testJwtDecoder() {
    return TestTokens.decoder();
  }

  @Bean
  @Primary
  RecordingMailSender recordingMailSender() {
    return new RecordingMailSender();
  }

  @Bean
  InMemoryObjectStore inMemoryObjectStore() {
    return new InMemoryObjectStore();
  }
}
