package com.example.system.shared;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.system.support.IntegrationTest;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import tools.jackson.databind.JsonNode;

/**
 * The OpenAPI document is the contract clients build against, so it is tested like code: every
 * route the application serves is documented, nothing documented is missing, the error shape is
 * declared on every operation, and a real response has exactly the fields its schema promises.
 */
class OpenApiContractIT extends IntegrationTest {

  @Autowired
  @Qualifier("requestMappingHandlerMapping")
  RequestMappingHandlerMapping mappings;

  private JsonNode document() {
    MvcTestResult result = get("/v3/api-docs", null);
    assertThat(result).hasStatus(HttpStatus.OK);
    return body(result);
  }

  /** "GET /api/v1/tasks/{id}" for every controller method in this application. */
  private Set<String> servedOperations() {
    Set<String> served = new HashSet<>();
    for (Map.Entry<RequestMappingInfo, HandlerMethod> e : mappings.getHandlerMethods().entrySet()) {
      if (!e.getValue().getBeanType().getName().startsWith("com.example.system")) {
        continue;
      }
      var patterns = e.getKey().getPathPatternsCondition().getPatternValues();
      for (String pattern : patterns) {
        for (var method : e.getKey().getMethodsCondition().getMethods()) {
          served.add(method.name() + " " + pattern);
        }
      }
    }
    return served;
  }

  private Set<String> documentedOperations(JsonNode doc) {
    Set<String> documented = new HashSet<>();
    doc.path("paths")
        .properties()
        .forEach(
            path ->
                path.getValue()
                    .properties()
                    .forEach(
                        op -> documented.add(op.getKey().toUpperCase() + " " + path.getKey())));
    return documented;
  }

  @Test
  void isOpenApi31() {
    assertThat(document().path("openapi").asString()).startsWith("3.1");
  }

  @Test
  void everyServedRouteIsDocumentedAndEveryDocumentedRouteIsServed() {
    JsonNode doc = document();

    assertThat(servedOperations()).isNotEmpty();
    assertThat(documentedOperations(doc)).containsExactlyInAnyOrderElementsOf(servedOperations());
  }

  @Test
  void everyOperationDeclaresTheProblemShapeForItsErrors() {
    JsonNode doc = document();

    doc.path("paths")
        .properties()
        .forEach(
            path ->
                path.getValue()
                    .properties()
                    .forEach(
                        op -> {
                          JsonNode responses = op.getValue().path("responses");
                          String where = op.getKey() + " " + path.getKey();
                          assertThat(responses.has("500")).as(where + " documents 500").isTrue();
                          assertThat(responses.has("429")).as(where + " documents 429").isTrue();
                          assertThat(
                                  responses
                                      .path("500")
                                      .path("content")
                                      .has("application/problem+json"))
                              .as(where + " 500 is problem+json")
                              .isTrue();
                        }));
    assertThat(doc.path("components").path("schemas").has("Problem")).isTrue();
  }

  @Test
  void theSessionRoutesAreMarkedPublicAndTheRestRequireACredential() {
    JsonNode doc = document();
    JsonNode paths = doc.path("paths");

    assertThat(paths.path("/api/v1/session").path("get").path("security")).isEmpty();
    assertThat(doc.path("security").toString()).contains("session-cookie").contains("bearer-jwt");
    assertThat(paths.path("/api/v1/tasks").path("get").path("responses").has("401")).isTrue();
    assertThat(paths.path("/api/v1/admin/audit").path("get").path("responses").has("403")).isTrue();
  }

  @Test
  void aRealTaskResponseHasExactlyTheDocumentedFields() {
    Set<String> promised =
        document()
            .path("components")
            .path("schemas")
            .path("TaskResponse")
            .path("properties")
            .propertyNames()
            .stream()
            .collect(Collectors.toSet());

    JsonNode actual =
        body(post("/api/v1/tasks", newMember(), Map.of("title", "contract", "description", "d")));

    assertThat(promised).isNotEmpty();
    assertThat(actual.propertyNames()).containsExactlyInAnyOrderElementsOf(promised);
  }

  @Test
  void aRealProblemHasOnlyFieldsTheProblemSchemaDeclares() {
    Set<String> declared =
        document()
            .path("components")
            .path("schemas")
            .path("Problem")
            .path("properties")
            .propertyNames()
            .stream()
            .collect(Collectors.toSet());

    JsonNode problem = body(post("/api/v1/tasks", newMember(), Map.of("title", " ")));

    assertThat(declared).containsAll(problem.propertyNames());
  }

  @Test
  void theSwaggerUiPageIsServedWhenEnabled() {
    assertThat(get("/swagger-ui/index.html", null)).hasStatus(HttpStatus.OK);
  }
}
