-- Schema v1. Flyway runs each V<n>__ file once, in order, and records it; a deployed database has
-- already run the earlier files, so never edit one: add the next V<n>__ file instead.
-- Written in plain SQL that PostgreSQL and H2 (the test fallback) both accept.

create table accounts (
    id            uuid                     not null,
    email         varchar(254)             not null,
    password_hash varchar(255)             not null,
    created_at    timestamp with time zone not null,
    version       bigint                   not null,
    constraint pk_accounts primary key (id),
    constraint uq_accounts_email unique (email)
);

create table items (
    id          uuid                     not null,
    owner_id    uuid                     not null,
    name        varchar(120)             not null,
    description varchar(2000),
    created_at  timestamp with time zone not null,
    updated_at  timestamp with time zone not null,
    version     bigint                   not null,
    constraint pk_items primary key (id),
    constraint fk_items_owner foreign key (owner_id) references accounts (id) on delete cascade
);

-- Serves "my items, newest first" without a sort step.
create index idx_items_owner_created on items (owner_id, created_at desc, id);
