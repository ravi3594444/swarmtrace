-- API keys are now stored as SHA-256 hashes with a short display prefix.
-- Adds the prefix column and backfills existing plaintext keys so they
-- keep working after the ingest path switched to hash comparison.

create extension if not exists pgcrypto;

alter table public.api_keys
  add column if not exists prefix text;

-- Plaintext keys start with 'st_'; hashed keys are 64-char hex.
update public.api_keys
set prefix = substring(key from 1 for 8),
    key    = encode(digest(key, 'sha256'), 'hex')
where key like 'st\_%' escape '\';

-- Keys inserted before this migration that were already hashed elsewhere
-- (defensive): give them a placeholder prefix so the UI never shows null.
update public.api_keys
set prefix = 'st_*****'
where prefix is null;
