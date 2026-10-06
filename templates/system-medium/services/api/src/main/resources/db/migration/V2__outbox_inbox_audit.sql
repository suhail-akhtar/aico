-- Outbox, inbox and audit.

-- The transactional outbox: Spring Modulith (spring-modulith-events-jdbc 2.1, schema v2) writes one
-- row per (event, listener) in the publisher transaction and marks it complete when the listener
-- returns. A row that stays incomplete is retried by the worker. Created here, by Flyway, so the
-- application never needs permission to create tables at runtime.
create table event_publication (
    id                     uuid                     not null,
    listener_id            text                     not null,
    event_type             text                     not null,
    serialized_event       text                     not null,
    publication_date       timestamp with time zone not null,
    completion_date        timestamp with time zone,
    status                 text,
    completion_attempts    int,
    last_resubmission_date timestamp with time zone,
    primary key (id)
);
create index event_publication_serialized_event_hash_idx on event_publication using hash (serialized_event);
create index event_publication_by_completion_date_idx on event_publication (completion_date);

-- The consumers inbox: which message each consumer has already handled. The primary key is the
-- whole idempotency guarantee: inserting twice is a conflict, and a conflict means "already done".
create table processed_events (
    consumer     text                     not null,
    event_id     uuid                     not null,
    processed_at timestamp with time zone not null,
    primary key (consumer, event_id)
);
create index processed_events_by_age_idx on processed_events (processed_at);

-- Audit trail: append-only, enforced here and not only in application code.
create table audit_log (
    id          bigint generated always as identity,
    occurred_at timestamp with time zone not null,
    actor_id    uuid                     not null,
    actor_label varchar(254)             not null,
    action      varchar(64)              not null,
    target_type varchar(64)              not null,
    target_id   varchar(64)              not null,
    detail      jsonb                    not null,
    request_id  varchar(64),
    primary key (id)
);
create index idx_audit_occurred on audit_log (occurred_at desc);

create function audit_log_is_append_only() returns trigger
    language plpgsql as
$$
begin
    raise exception 'audit_log is append-only (% refused)', tg_op using errcode = 'restrict_violation';
end;
$$;

create trigger audit_log_no_update_delete
    before update or delete on audit_log
    for each row execute function audit_log_is_append_only();

create trigger audit_log_no_truncate
    before truncate on audit_log
    for each statement execute function audit_log_is_append_only();
