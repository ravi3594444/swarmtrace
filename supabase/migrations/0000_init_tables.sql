-- 0000_init_tables.sql
-- Creates the tables the dashboard and ingest API expect.
-- Run this FIRST in the Supabase SQL editor, then 0001_rls_and_indexes.sql.
-- If the dashboard shows "Failed to create API key", missing tables or
-- missing SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are the usual cause.

create table if not exists public.api_keys (
  id          text primary key,
  key_hash    text not null,
  key_prefix  text not null,
  user_id     text not null,
  name        text not null default 'New Key',
  created_at  timestamptz not null default now(),
  last_used   timestamptz,
  revoked     boolean not null default false
);

create table if not exists public.traces (
  id            text not null,
  user_id       text not null,
  parent_id     text,
  function      text not null,
  args          text not null default '',
  output        text not null default '',
  latency_sec   double precision not null default 0,
  error         text,
  timestamp     timestamptz not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      double precision not null default 0,
  primary key (user_id, id)
);
