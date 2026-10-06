# syntax=docker/dockerfile:1
#
# Production image: build the jar, split it into layers, run it as a non-root user on a JRE-only
# base. Base images are pinned by tag AND digest so a rebuild is reproducible; Dependabot
# (.github/dependabot.yml) proposes digest bumps. The layers are ordered so dependencies, which
# change rarely, stay cached when only application code changes.

# ---- build ----------------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-25@sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976 AS build
WORKDIR /build

COPY .mvn .mvn
COPY mvnw pom.xml spotbugs-exclude.xml ./
COPY src src

# Tests, coverage and static analysis run in CI before an image is built (make check); the image
# build only packages. The cache mount keeps the Maven repository between builds, not in a layer.
RUN --mount=type=cache,target=/root/.m2 sh ./mvnw -B -ntp -DskipTests -Dspotless.check.skip=true package \
 && java -Djarmode=tools -jar target/app.jar extract --layers --launcher --destination /build/layers

# ---- runtime --------------------------------------------------------------------------------
FROM eclipse-temurin:25-jre-alpine@sha256:3c0a9084927a221ccd1d007fcaf614465672c0af37aaa834c5184483afe56d61

# Fixed numeric ids so file ownership is predictable on every host and in Kubernetes.
RUN addgroup -g 10001 -S app && adduser -u 10001 -S -G app -H -h /app app
WORKDIR /app

COPY --from=build --chown=app:app /build/layers/dependencies/ ./
COPY --from=build --chown=app:app /build/layers/spring-boot-loader/ ./
COPY --from=build --chown=app:app /build/layers/snapshot-dependencies/ ./
COPY --from=build --chown=app:app /build/layers/application/ ./

USER 10001:10001

# prod profile: JSON logs, API explorer off. Everything else comes from environment variables.
ENV SPRING_PROFILES_ACTIVE=prod \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError -Djava.io.tmpdir=/tmp"

EXPOSE 8080

# Liveness only (no dependencies): the orchestrator restarts the container if the JVM wedges.
# wget is BusyBox's; there is no curl in this image.
HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=3 \
  CMD ["sh", "-c", "wget -q -O /dev/null http://127.0.0.1:${PORT:-8080}/healthz || exit 1"]

# Exec form, so the JVM is PID 1 and receives SIGTERM for graceful shutdown.
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
