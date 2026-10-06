# Backlog

## Iteration 0: the foundation (done)

- [x] **Run the whole system with one command**
  Done when: `docker compose up --build --wait` reports every container healthy and `node scripts/smoke.mjs` passes.
- [x] **Sign in through Keycloak (BFF cookie session)**
  Done when: alice signs in at http://localhost:8080, `/api/v1/session` shows her and the ADMIN role; a POST without `X-XSRF-TOKEN` is 403.
- [x] **Tasks with assignment**
  Done when: a task created for bob is visible to alice; bob gets 404 for it; title and assignee are validated.
- [x] **Outbox mail on assignment**
  Done when: assigning writes the event with the task; Mailpit shows the mail to bob; with SMTP down the delivery stays pending and the worker republishes it.
- [x] **Audit trail**
  Done when: every task change has an audit row with actor and request id; an admin can read it, a member gets 403.
- [x] **Attachments on S3 and feature flags**
  Done when: a file uploaded to a task is stored in SeaweedFS and downloads back identical; flipping `attachments-enabled` in flagd turns the feature off.
- [x] **Checks**
  Done when: `./mvnw verify` (unit + integration tests, 85% coverage gate, SpotBugs) and `npm run check` (web tests) pass.

## Iteration 1: make it yours

- [ ] Replace "tasks" with your own first module (see docs/EXTENDING.md).
- [ ] Rename `com.example.system` and the `system-*` image names.
- [ ] Production Keycloak: `start` with a hostname, TLS in front of Traefik, no dev users.
- [ ] Back up the PostgreSQL and SeaweedFS volumes; test a restore.
- [ ] Wire telemetry to your collector (`APP_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`).
