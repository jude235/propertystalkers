-- =====================================================================
-- Property Stalkers database
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run more than once.
-- =====================================================================


-- One row per signed-in user. Name and phone are shown on their posts.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  name        text,
  phone       text,
  rera_number text,            -- set when the user posts as a broker
  created_at  timestamptz not null default now()
);

-- Every listing (landlord / broker) and request (buyer / tenant).
create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('listing', 'request')),
  poster_type   text not null check (poster_type in ('landlord', 'broker', 'buyer', 'tenant')),
  deal          text not null check (deal in ('sale', 'rent')),
  property_type text,
  bedrooms      int,
  price         bigint,          -- asking price / monthly rent, or budget for requests (INR)
  building      text,
  locality      text,            -- sector / area
  city          text,
  address       text,            -- address Google matched
  lat           double precision not null,
  lng           double precision not null,
  precision     text not null check (precision in ('building', 'area')),
  building_key  text,            -- normalised building + city, used for "same building" matching
  place_id      text,
  rera_number   text,
  description   text,
  photos        jsonb not null default '[]'::jsonb,
  contact_name  text,
  contact_phone text,
  status        text not null default 'active' check (status in ('active', 'removed')),
  created_at    timestamptz not null default now()
);
-- Added for worldwide listings (safe to re-run on an existing database).
alter table public.posts add column if not exists currency text not null default 'INR';
alter table public.posts add column if not exists country text;
-- Added for developer listings (safe to re-run).
alter table public.posts add column if not exists company text;
alter table public.posts add column if not exists possession text;
alter table public.posts drop constraint if exists posts_poster_type_check;
alter table public.posts add constraint posts_poster_type_check
  check (poster_type in ('landlord', 'broker', 'developer', 'buyer', 'tenant'));

create index if not exists posts_status_kind_idx on public.posts (status, kind);
create index if not exists posts_user_idx on public.posts (user_id);
create index if not exists posts_building_idx on public.posts (building_key);

-- Drafts the AI prepared and the user has not confirmed yet.
create table if not exists public.drafts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

-- Daily AI message count per user (keeps the AI bill under control).
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  calls   int  not null default 0,
  primary key (user_id, day)
);

create or replace function public.bump_ai_usage(uid uuid) returns int
language sql as $$
  insert into public.ai_usage (user_id, day, calls) values (uid, current_date, 1)
  on conflict (user_id, day) do update set calls = public.ai_usage.calls + 1
  returning calls;
$$;
revoke execute on function public.bump_ai_usage(uuid) from public, anon, authenticated;

-- Lock every table: browsers cannot read or write them directly.
-- All access goes through the site's server, which applies the visibility rules.
alter table public.profiles enable row level security;
alter table public.posts    enable row level security;
alter table public.drafts   enable row level security;
alter table public.ai_usage enable row level security;

-- Photo storage: public to view, each user may upload only into their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Users upload own photos" on storage.objects;
create policy "Users upload own photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
