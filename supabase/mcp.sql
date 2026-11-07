-- =====================================================================
-- Property Stalkers connector for Claude (MCP): sign-in records and rate limits.
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run more than once.
--
-- Only the site's server (service key) can read or write these tables.
-- Codes and tokens are stored as SHA-256 hashes, never as the values themselves.
-- =====================================================================

-- Apps that registered to connect (Claude registers itself automatically).
create table if not exists public.mcp_clients (
  client_id     text primary key,
  client_name   text,
  redirect_uris jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- One-time codes handed back after someone taps Allow (valid for 5 minutes, used once).
create table if not exists public.mcp_codes (
  code_hash      text primary key,
  client_id      text not null,
  user_id        uuid not null references auth.users(id) on delete cascade,
  email          text,
  redirect_uri   text not null,
  code_challenge text not null,
  scope          text,
  resource       text,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);

-- Access tokens (1 hour) and refresh tokens (60 days, replaced on every use).
-- "family" ties every token from one Allow together, so a stolen refresh token that is
-- used twice switches off the whole connection.
create table if not exists public.mcp_tokens (
  token_hash  text primary key,
  kind        text not null check (kind in ('access', 'refresh')),
  family      text not null,
  client_id   text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text,
  scope       text,
  resource    text,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  rotated_at  timestamptz,   -- a refresh token replaced by a newer one (a quick retry is still accepted)
  created_at  timestamptz not null default now()
);
alter table public.mcp_tokens add column if not exists rotated_at timestamptz;
create index if not exists mcp_tokens_user_idx on public.mcp_tokens (user_id);
create index if not exists mcp_tokens_family_idx on public.mcp_tokens (family);
create index if not exists mcp_codes_expiry_idx on public.mcp_codes (expires_at);
create index if not exists mcp_tokens_expiry_idx on public.mcp_tokens (expires_at);

-- Calls per caller per hour (rate limits). key is 'ip:<address>' or 'u:<user id>' plus a bucket name.
create table if not exists public.mcp_usage (
  key          text not null,
  window_start timestamptz not null,
  calls        int not null default 0,
  primary key (key, window_start)
);

create or replace function public.bump_mcp_usage(k text, w timestamptz) returns int
language sql as $$
  insert into public.mcp_usage (key, window_start, calls) values (k, w, 1)
  on conflict (key, window_start) do update set calls = public.mcp_usage.calls + 1
  returning calls;
$$;
revoke execute on function public.bump_mcp_usage(text, timestamptz) from public, anon, authenticated;

-- Lock every table: browsers cannot read or write them directly.
alter table public.mcp_clients enable row level security;
alter table public.mcp_codes   enable row level security;
alter table public.mcp_tokens  enable row level security;
alter table public.mcp_usage   enable row level security;
