package com.example.app.shared;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.app.support.IntegrationTest;
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

  /** "GET /api/v1/items/{id}" for every controller method in this application. */
  private Set<String> servedOperations() {
    Set<String> served = new HashSet<>();
    for (Map.Entry<RequestMappingInfo, HandlerMethod> e : mappings.getHandlerMethods().entrySet()) {
      if (!e.getValue().getBeanType().getName().startsWith("com.example.app")) {
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
  void publicOperationsAreMarkedPublicAndTheRestRequireTheBearerScheme() {
    JsonNode paths = document().path("paths");

    assertThat(paths.path("/api/v1/auth/login").path("post").path("security")).isEmpty();
    assertThat(paths.path("/api/v1/auth/register").path("post").path("security")).isEmpty();
    assertThat(document().path("security").toString()).contains("bearer-jwt");
    assertThat(paths.path("/api/v1/items").path("get").path("responses").has("401")).isTrue();
  }

  @Test
  void aRealItemResponseHasExactlyTheDocumentedFields() {
    JsonNode doc = document();
    Set<String> promised =
        doc
            .path("components")
            .path("schemas")
            .path("ItemResponse")
            .path("properties")
            .propertyNames()
            .stream()
            .collect(Collectors.toSet());
    String token = newUserToken();

    JsonNode actual =
        body(post("/api/v1/items", token, Map.of("name", "contract", "description", "d")));

    assertThat(promised).isNotEmpty();
    assertThat(actual.propertyNames()).containsExactlyInAnyOrderElementsOf(promised);
  }

  private Set<String> promisedBy(String schema) {
    return document()
        .path("components")
        .path("schemas")
        .path(schema)
        .path("properties")
        .propertyNames()
        .stream()
        .collect(Collectors.toSet());
  }

  @Test
  void everyDocumentedPropertyNameIsSnakeCase() {
    document()
        .path("components")
        .path("schemas")
        .properties()
        .forEach(
            schema ->
                assertThat(schema.getValue().path("properties").propertyNames())
                    .as("properties of " + schema.getKey())
                    .allMatch(name -> name.matches("[a-z][a-z0-9_]*")));
  }

  @Test
  void theOtherRealResponsesAlsoMatchTheirDocumentedSchemas() {
    String email = uniqueEmail();
    JsonNode registered =
        body(post("/api/v1/auth/register", null, Map.of("email", email, "password", PASSWORD)));
    JsonNode login =
        body(post("/api/v1/auth/login", null, Map.of("email", email, "password", PASSWORD)));
    String token = login.path("access_token").asString();
    createItem(token, "listed");

    JsonNode list = body(get("/api/v1/items", token));

    assertThat(registered.propertyNames())
        .containsExactlyInAnyOrderElementsOf(promisedBy("AccountResponse"));
    assertThat(login.propertyNames())
        .containsExactlyInAnyOrderElementsOf(promisedBy("TokenResponse"));
    assertThat(list.propertyNames())
        .containsExactlyInAnyOrderElementsOf(promisedBy("CursorPageItemResponse"));
  }

  @Test
  void theListOperationDocumentsLimitAndCursorAndNotTheRetiredOffsetParameters() {
    JsonNode parameters =
        document().path("paths").path("/api/v1/items").path("get").path("parameters");
    Set<String> names =
        parameters.valueStream().map(p -> p.path("name").asString()).collect(Collectors.toSet());

    assertThat(names).containsExactlyInAnyOrder("limit", "cursor", "q");
    JsonNode limit =
        parameters
            .valueStream()
            .filter(p -> p.path("name").asString().equals("limit"))
            .findFirst()
            .orElseThrow();
    assertThat(limit.path("schema").path("minimum").asInt()).isEqualTo(1);
    assertThat(limit.path("schema").path("maximum").asInt()).isEqualTo(100);
    assertThat(limit.path("schema").path("default").asInt()).isEqualTo(50);
  }

  @Test
  void quantityIsOptionalAndBoundedInTheRequestSchema() {
    JsonNode request = document().path("components").path("schemas").path("ItemRequest");

    assertThat(request.path("properties").path("quantity").path("minimum").asInt()).isZero();
    assertThat(request.path("properties").path("quantity").path("maximum").asInt())
        .isEqualTo(1_000_000);
    assertThat(request.path("required").valueStream().map(JsonNode::asString))
        .containsExactly("name");
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

    JsonNode problem = body(post("/api/v1/items", newUserToken(), Map.of("name", " ")));

    assertThat(declared).containsAll(problem.propertyNames());
  }

  @Test
  void theSwaggerUiPageIsServedWhenEnabled() {
    assertThat(get("/swagger-ui/index.html", null)).hasStatus(HttpStatus.OK);
  }
}
