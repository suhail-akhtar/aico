using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace ApiService.Platform;

/// <summary>
/// The OpenAPI 3.1 document is generated from the endpoints (so it cannot drift from the code) and
/// then completed with what generation cannot know: the service identity, and the bearer scheme on
/// every operation that requires authorisation. The contract tests snapshot the result, so a change to
/// the API surface shows up as a reviewed diff.
/// </summary>
internal static class OpenApiSetup
{
    public const string BearerScheme = "Bearer";

    internal sealed class ServiceInfoTransformer : IOpenApiDocumentTransformer
    {
        public Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(document);
            document.Info = new OpenApiInfo
            {
                Title = "API service",
                Version = "v1",
                Description = "JSON API: JWT authentication with refresh-token rotation and a worked, owner-scoped items resource. Errors are RFC 9457 problem documents.",
            };
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>(StringComparer.Ordinal);
            document.Components.SecuritySchemes[BearerScheme] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                BearerFormat = "JWT",
                Description = "Access token from POST /auth/login or /auth/register.",
            };
            return Task.CompletedTask;
        }
    }

    internal sealed class BearerOperationTransformer : IOpenApiOperationTransformer
    {
        public Task TransformAsync(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(operation);
            ArgumentNullException.ThrowIfNull(context);
            var requiresAuth = context.Description.ActionDescriptor.EndpointMetadata.OfType<IAuthorizeData>().Any()
                && !context.Description.ActionDescriptor.EndpointMetadata.OfType<IAllowAnonymous>().Any();
            if (requiresAuth)
            {
                operation.Security ??= [];
                operation.Security.Add(new OpenApiSecurityRequirement
                {
                    [new OpenApiSecuritySchemeReference(BearerScheme, context.Document)] = [],
                });
            }

            return Task.CompletedTask;
        }
    }
}
