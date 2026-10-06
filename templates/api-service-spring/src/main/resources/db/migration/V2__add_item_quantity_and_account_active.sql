-- Schema v2. V1 is applied on every deployed database and must never be edited; changes land here.
-- Plain SQL that PostgreSQL and H2 (the test fallback) both accept.

-- Items carry a stock-like count, part of the API contract shared with the other starters
-- (0..1,000,000, default 0). The default backfills existing rows; the check keeps bad data out even
-- if a future code path skips the domain's own validation.
alter table items add column quantity integer default 0 not null;
alter table items add constraint ck_items_quantity check (quantity >= 0 and quantity <= 1000000);

-- An account can be switched off. Existing accounts stay active. Honoured at local login and, in
-- oidc mode, on every request (the account then answers 403 account_disabled).
alter table accounts add column is_active boolean default true not null;
