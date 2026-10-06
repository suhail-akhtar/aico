package com.example.app.identity.api;

import com.example.app.shared.error.LocalAuthDisabledException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * In {@code APP_AUTH_MODE=oidc} the credential endpoints answer 404 ("Local authentication is
 * disabled"). It is an interceptor rather than a check inside the controller methods so the answer
 * comes before request-body validation: a bad body must not turn a disabled endpoint into a 400. It
 * is only registered in oidc mode, so local mode is untouched.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.auth", name = "mode", havingValue = "oidc")
class LocalAuthGuard implements WebMvcConfigurer {

  @Override
  public void addInterceptors(InterceptorRegistry registry) {
    registry
        .addInterceptor(
            new HandlerInterceptor() {
              @Override
              public boolean preHandle(
                  HttpServletRequest request, HttpServletResponse response, Object handler) {
                throw new LocalAuthDisabledException();
              }
            })
        .addPathPatterns("/api/v1/auth/register", "/api/v1/auth/login");
  }
}
