-- Schema v1. Flyway runs each V<n>__ file once, in order, and records it; a deployed database has
-- already run the earlier files, so never edit one: add the next V<n>__ file instead.

-- People the identity provider has vouched for. The id is the provider subject (a UUID in
-- Keycloak). This is a directory for foreign keys and display names, not a credential store.
create table users (
    id            uuid                     not null,
    email         varchar(254),
    display_name  varchar(200)             not null,
    created_at    timestamp with time zone not null,
    last_login_at timestamp with time zone not null,
    version       bigint                   not null,
    constraint pk_users primary key (id)
);

create table tasks (
    id             uuid                     not null,
    owner_id       uuid                     not null,
    title          varchar(120)             not null,
    description    varchar(2000),
    status         varchar(16)              not null,
    assignee_email varchar(254),
    created_at     timestamp with time zone not null,
    updated_at     timestamp with time zone not null,
    version        bigint                   not null,
    constraint pk_tasks primary key (id),
    constraint fk_tasks_owner foreign key (owner_id) references users (id) on delete cascade,
    constraint ck_tasks_status check (status in ('OPEN', 'DONE'))
);

-- Serves "my tasks, newest first" without a sort step, and the open-task limit count.
create index idx_tasks_owner_created on tasks (owner_id, created_at desc, id);
create index idx_tasks_owner_status on tasks (owner_id, status);

-- File metadata. The bytes live in object storage under object_key (built from ids only).
create table task_attachments (
    id           uuid                     not null,
    task_id      uuid                     not null,
    file_name    varchar(200)             not null,
    content_type varchar(100)             not null,
    size_bytes   bigint                   not null,
    object_key   varchar(200)             not null,
    created_at   timestamp with time zone not null,
    constraint pk_task_attachments primary key (id),
    constraint fk_attachments_task foreign key (task_id) references tasks (id) on delete cascade,
    constraint ck_attachments_size check (size_bytes > 0)
);

create index idx_attachments_task on task_attachments (task_id, created_at);
