#!/bin/sh
# Runs once, when the data directory is first created: a separate database and role for Keycloak,
# so the identity provider and the API never share credentials or tables.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE keycloak LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}';
CREATE DATABASE keycloak OWNER keycloak;
SQL
