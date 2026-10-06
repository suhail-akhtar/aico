# syntax=docker/dockerfile:1

# Multi-stage: the SDK image restores and publishes; only the published output reaches the runtime image.
# Both base images are pinned to an exact patch version (Dependabot proposes bumps, a person merges them).

# ---- build ---------------------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0.401-noble AS build
WORKDIR /src

# Restore first, from the files that decide the dependency graph, so this layer is cached until a package changes.
# (.editorconfig comes along because it holds the analyzer severities the build enforces.) --locked-mode fails the
# build if packages.lock.json does not match the project: what was reviewed is what ships. NuGet Audit runs here
# too and fails the build on a high or critical advisory.
COPY global.json nuget.config .editorconfig Directory.Build.props Directory.Packages.props audit-allowlist.props ./
COPY src/ApiService/ApiService.csproj src/ApiService/packages.lock.json src/ApiService/
RUN dotnet restore src/ApiService/ApiService.csproj --locked-mode

COPY src/ src/
RUN dotnet publish src/ApiService/ApiService.csproj -c Release --no-restore -o /app/publish \
    -p:UseAppHost=true -p:DebugType=none

# ---- runtime -------------------------------------------------------------------------------------
# Chiseled Ubuntu: no shell, no package manager, no curl, runs as a non-root user (uid 1654, "app") by default.
FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble-chiseled AS runtime
WORKDIR /app
COPY --from=build --chown=1654:1654 /app/publish ./

ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_gcServer=0
USER 1654
EXPOSE 8080

# No shell and no curl in this image, so the application is its own probe (`ApiService --healthcheck`).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/app/ApiService", "--healthcheck"]

# Exec form, so SIGTERM reaches the process and shutdown is graceful. `docker run <image> --migrate`
# applies the database migrations and exits (the one-shot job for production).
ENTRYPOINT ["/app/ApiService"]
