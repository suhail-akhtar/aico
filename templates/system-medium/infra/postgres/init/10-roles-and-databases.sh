#!/bin/sh
# Runs once, when the PostgreSQL data directory is first created. One server, two databases, two
# roles: the application's and Keycloak's. Neither role is a superuser, and each owns only its own
# database, so a SQL injection in the app cannot read the identity provider's tables.
#
# Passwords arrive as environment variables and are passed to psql as variables (never spliced into
# the SQL text by the shell), so a password containing a quote cannot break out of the statement.
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
: "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$APP_DB_PASSWORD" -v keycloak_password="$KEYCLOAK_DB_PASSWORD" <<'SQL'
create role app login password :'app_password';
create database app owner app;
revoke all on database app from public;

create role keycloak login password :'keycloak_password';
create database keycloak owner keycloak;
revoke all on database keycloak from public;
SQL
