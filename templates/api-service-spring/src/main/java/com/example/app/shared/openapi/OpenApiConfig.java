package com.example.app.shared.openapi;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.Operation;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.media.Content;
import io.swagger.v3.oas.models.media.IntegerSchema;
import io.swagger.v3.oas.models.media.MediaType;
import io.swagger.v3.oas.models.media.ObjectSchema;
import io.swagger.v3.oas.models.media.Schema;
import io.swagger.v3.oas.models.media.StringSchema;
import io.swagger.v3.oas.models.responses.ApiResponse;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springdoc.core.properties.SpringDocConfigProperties;
import org.springdoc.core.providers.ObjectMapperProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The API contract's metadata: title, the bearer scheme, and the shared error shape. Operations
 * come from the controllers; every operation also gets the problem responses it can produce so
 * clients see the whole contract, not only the happy path.
 */
@Configuration(proxyBeanMethods = false)
class OpenApiConfig {

  static final String BEARER = "bearer-jwt";
  static final String PROBLEM_REF = "#/components/schemas/Problem";

  @Bean
  OpenAPI apiInfo() {
    return new OpenAPI()
        .info(new Info().title("API service").version("0.1.0"))
        .components(
            new Components()
                .addSecuritySchemes(
                    BEARER,
                    new SecurityScheme()
                        .type(SecurityScheme.Type.HTTP)
                        .scheme("bearer")
                        .bearerFormat("JWT")))
        .addSecurityItem(new SecurityRequirement().addList(BEARER));
  }

  /**
   * springdoc derives schemas with its own Jackson 2 mapper (from swagger-core), not the Jackson 3
   * mapper Spring MVC serialises with, so the {@code SNAKE_CASE} setting in {@code
   * application.properties} would not reach the document and it would advertise {@code createdAt}
   * while the API sends {@code created_at}. This gives the schema mapper the same strategy; {@code
   * OpenApiContractIT} compares real responses with the document to keep the two honest.
   */
  @Bean
  ObjectMapperProvider objectMapperProvider(SpringDocConfigProperties config) {
    return new ObjectMapperProvider(config) {
      @Override
      public ObjectMapper jsonMapper() {
        return super.jsonMapper().setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);
      }
    };
  }

  @Bean
  OpenApiCustomizer problemResponses() {
    return openApi -> {
      Components components = openApi.getComponents();
      components.addSchemas("Problem", problemSchema());
      openApi
          .getPaths()
          .forEach(
              (path, item) ->
                  item.readOperations()
                      .forEach(
                          op -> {
                            boolean secured =
                                op.getSecurity() == null || !op.getSecurity().isEmpty();
                            if (secured) {
                              addProblem(op, "401", "Missing, invalid or expired access token");
                            }
                            if (path.contains("{")) {
                              addProblem(op, "404", "No such resource for this caller");
                            }
                            addProblem(op, "400", "The request is malformed or invalid");
                            addProblem(op, "429", "Rate limit exceeded; see Retry-After");
                            addProblem(op, "500", "Unexpected server error");
                          }));
    };
  }

  private static void addProblem(Operation operation, String status, String description) {
    if (operation.getResponses().containsKey(status)) {
      return;
    }
    Content content =
        new Content()
            .addMediaType(
                "application/problem+json",
                new MediaType().schema(new Schema<>().$ref(PROBLEM_REF)));
    operation
        .getResponses()
        .addApiResponse(status, new ApiResponse().description(description).content(content));
  }

  private static Schema<?> problemSchema() {
    Schema<?> field =
        new ObjectSchema()
            .addProperty("field", new StringSchema())
            .addProperty("message", new StringSchema());
    return new ObjectSchema()
        .description("RFC 9457 problem details")
        .addProperty("type", new StringSchema().example("urn:problem-type:not-found"))
        .addProperty("title", new StringSchema())
        .addProperty("status", new IntegerSchema())
        .addProperty("detail", new StringSchema())
        .addProperty("instance", new StringSchema())
        .addProperty("code", new StringSchema().example("not_found"))
        .addProperty("request_id", new StringSchema())
        .addProperty("errors", new io.swagger.v3.oas.models.media.ArraySchema().items(field));
  }
}
