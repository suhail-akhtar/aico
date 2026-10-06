# syntax=docker/dockerfile:1.7
# One Dockerfile, four jobs. Every base image is pinned to an exact version AND
# a digest (Dependabot's docker ecosystem bumps both).
#
#   tools    PHP CLI + Composer + PCOV + pdo_pgsql: runs EVERY check (`make check`).
#            This is how the project builds on a machine with no PHP installed.
#   assets   Node, only here: Vite + Tailwind compile to public/build. Node is never
#            in the runtime image.
#   vendor   production composer install (no dev packages).
#   runtime  FrankenPHP (Caddy + PHP in one process), non-root, port 8080.
#            `docker build .` builds this one (it is the last stage).

FROM composer:2.10.3@sha256:af98f42dfff7c68ba8d53c2164fd9fde1087b7d449514baa38c418b1f6bc4bac AS composer-bin

# ---------------------------------------------------------------------------
FROM php:8.5.11-cli-alpine3.24@sha256:93684051146ec037620855feb77f278090bde45ddc030801cd3f2a7685bc4deb AS tools
COPY --from=ghcr.io/mlocati/php-extension-installer:2.12.0 /usr/bin/install-php-extensions /usr/local/bin/
COPY --from=composer-bin /usr/bin/composer /usr/local/bin/composer
RUN apk add --no-cache git unzip make \
 && install-php-extensions pdo_pgsql intl bcmath pcntl zip pcov \
 && adduser -D -u 1000 dev \
 && mkdir -p /app/vendor /home/dev/.cache/composer \
 && chown -R dev:dev /app /home/dev
ENV COMPOSER_HOME=/home/dev/.cache/composer \
    COMPOSER_CACHE_DIR=/home/dev/.cache/composer/cache \
    COMPOSER_NO_INTERACTION=1 \
    PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d
# Coverage needs a few hundred MB; the CLI default of 128M is too small for PHPStan.
RUN printf 'memory_limit=1G\npcov.enabled=0\npcov.directory=/app/app\n' > /usr/local/etc/php/conf.d/zz-tools.ini
WORKDIR /app
USER dev

# ---------------------------------------------------------------------------
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS assets
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.js ./
COPY resources ./resources
RUN npm run build

# ---------------------------------------------------------------------------
FROM tools AS vendor
USER dev
WORKDIR /app
COPY --chown=dev:dev composer.json composer.lock ./
RUN --mount=type=cache,target=/home/dev/.cache/composer,uid=1000,gid=1000 \
    composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-progress
COPY --chown=dev:dev . .
RUN composer dump-autoload --no-dev --classmap-authoritative --no-scripts \
 && php artisan package:discover --ansi

# ---------------------------------------------------------------------------
FROM dunglas/frankenphp:1.13.0-php8.5.11-alpine@sha256:b64048cc72ee412fd7247f45d70011c385850c0bfd0b467cd26cdccc99e158ca AS runtime
RUN install-php-extensions pdo_pgsql intl bcmath pcntl opcache \
 && apk add --no-cache libcap \
 # The binary ships with cap_net_bind_service for ports 80/443. We listen on 8080
 # as a non-root user with every capability dropped, so a file capability would
 # make exec fail ("operation not permitted"). Remove it.
 && setcap -r /usr/local/bin/frankenphp \
 && apk del libcap \
 && adduser -D -u 10001 app \
 && mkdir -p /app && chown app:app /app
COPY docker/php.ini /usr/local/etc/php/conf.d/zz-app.ini
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint
WORKDIR /app
# Everything that varies at runtime is derived into /tmp (a tmpfs) so the
# container runs with a read-only root filesystem.
ENV APP_ENV=production \
    APP_DEBUG=false \
    LOG_CHANNEL=stderr \
    XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data \
    APP_CONFIG_CACHE=/tmp/bootstrap/config.php \
    APP_ROUTES_CACHE=/tmp/bootstrap/routes-v7.php \
    APP_EVENTS_CACHE=/tmp/bootstrap/events.php \
    APP_SERVICES_CACHE=/tmp/bootstrap/services.php \
    VIEW_COMPILED_PATH=/tmp/bootstrap/views \
    SERVER_NAME=:8080
COPY --from=vendor --chown=app:app /app /app
COPY --from=assets --chown=app:app /build/public/build /app/public/build
RUN rm -rf /app/tests /app/docker /app/.git* /app/docs /app/phpunit.xml /app/phpstan.neon /app/Makefile /app/Dockerfile \
 && mkdir -p storage/app storage/framework/cache storage/framework/sessions storage/logs \
 && chown -R app:app storage bootstrap/cache
USER app
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["entrypoint"]
CMD ["frankenphp", "run", "--config", "/etc/caddy/Caddyfile"]
