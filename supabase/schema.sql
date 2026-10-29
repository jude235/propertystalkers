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
-- Added for roles and developer configurations (safe to re-run).
alter table public.posts add column if not exists configs text;
alter table public.profiles add column if not exists role text;
alter table public.profiles add column if not exists company text;
-- Unit numbers, sizes and lead rotation (safe to re-run).
alter table public.posts add column if not exists unit_number text;   -- never shown to visitors
alter table public.posts add column if not exists unit_key text;      -- deal | building+city | unit, for the 3-per-unit rule
alter table public.posts add column if not exists size_sqft bigint;
create index if not exists posts_unit_idx on public.posts (unit_key) where status = 'active';
create table if not exists public.unit_leads (
  unit_key text primary key,
  leads    int not null default 0
);
create table if not exists public.leads (
  id         bigint generated always as identity primary key,
  unit_key   text not null,
  post_id    uuid not null references public.posts(id) on delete cascade,
  viewer_id  uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create or replace function public.next_lead(k text) returns int
language sql as $$
  insert into public.unit_leads (unit_key, leads) values (k, 1)
  on conflict (unit_key) do update set leads = public.unit_leads.leads + 1
  returning leads;
$$;
revoke execute on function public.next_lead(text) from public, anon, authenticated;
alter table public.unit_leads enable row level security;
alter table public.leads enable row level security;
-- Profile picture (safe to re-run).
alter table public.profiles add column if not exists avatar_url text;

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

-- ===================== Phase 1 + 2: assistant, alerts, leads, landlord tools (safe to re-run) =====================
alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check check (status in ('active', 'removed', 'expired'));
alter table public.posts add column if not exists first_price bigint;            -- price when first posted (for price-cut badges)
alter table public.posts add column if not exists price_changed_at timestamptz;
alter table public.posts add column if not exists confirmed_at timestamptz not null default now();  -- last "still available"
alter table public.posts add column if not exists stale_notified_at timestamptz;
alter table public.posts add column if not exists flags jsonb not null default '[]'::jsonb;  -- moderation / safety flags
alter table public.posts add column if not exists cobroke boolean not null default false;   -- broker open to co-broking
update public.posts set first_price = price where first_price is null;
alter table public.profiles add column if not exists notify_email boolean not null default true;

-- Everything a person is told about: alerts, price drops, enquiries, viewings, pitches, reminders.
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  post_id    uuid references public.posts(id) on delete cascade,
  ref_id     uuid,                 -- enquiry / request this is about
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- Saved searches ("alert me when...").
create table if not exists public.saved_searches (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  label      text not null,
  criteria   jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists saved_searches_user_idx on public.saved_searches (user_id);

-- Watched listings (price-drop alerts).
create table if not exists public.watches (
  user_id    uuid not null references auth.users(id) on delete cascade,
  post_id    uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

-- Questions, viewing requests, pitches to requests and co-broke requests.
create table if not exists public.enquiries (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('question', 'viewing', 'pitch', 'cobroke')),
  post_id    uuid not null references public.posts(id) on delete cascade,   -- the listing (for pitches: the pitched listing)
  request_id uuid references public.posts(id) on delete cascade,            -- pitches: the buyer / tenant request
  from_user  uuid not null references auth.users(id) on delete cascade,
  to_user    uuid not null references auth.users(id) on delete cascade,
  message    text,
  summary    text,
  slot       timestamptz,          -- viewings
  status     text not null default 'new' check (status in ('new', 'accepted', 'declined')),
  reminded   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists enquiries_to_idx on public.enquiries (to_user, created_at desc);
create index if not exists enquiries_from_idx on public.enquiries (from_user, created_at desc);

-- Landlord tools: tenancies with rent and renewal reminders, and a repair-request link for the tenant.
create table if not exists public.tenancies (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  label         text not null,
  tenant_name   text,
  tenant_phone  text,
  tenant_email  text,
  rent          bigint,
  currency      text,
  due_day       int check (due_day between 1 and 28),
  lease_end     date,
  repair_token  text not null unique,
  rent_reminded_for  text,         -- 'YYYY-MM' of the last rent reminder
  renewal_reminded   boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists tenancies_user_idx on public.tenancies (user_id);

-- When background jobs last ran (they run on normal traffic, at most every few hours).
create table if not exists public.site_jobs (
  name     text primary key,
  last_run timestamptz not null default now()
);

alter table public.notifications  enable row level security;
alter table public.saved_searches enable row level security;
alter table public.watches        enable row level security;
alter table public.enquiries      enable row level security;
alter table public.tenancies      enable row level security;
alter table public.site_jobs      enable row level security;

-- ===================== Let's share: rooms, bed spaces and flatmates (safe to re-run) =====================
alter table public.posts drop constraint if exists posts_deal_check;
alter table public.posts add constraint posts_deal_check check (deal in ('sale', 'rent', 'share'));
alter table public.posts add column if not exists room_type text;        -- private_room / shared_room / bed_space / whole_unit
alter table public.posts add column if not exists room text;             -- which room in the unit, e.g. "Room 2" (never shown to visitors)
alter table public.posts add column if not exists suits text;            -- any / male / female / couples
alter table public.posts add column if not exists bills_included boolean;
alter table public.posts add column if not exists move_in text;

-- Amenities chips (safe to re-run).
alter table public.posts add column if not exists amenities jsonb not null default '[]'::jsonb;

-- Five roles (Buyer / Tenant merged; Co-living / Homestays added), holiday homes by the night,
-- and co-living interests for matching flatmates (safe to re-run).
alter table public.posts drop constraint if exists posts_poster_type_check;
alter table public.posts add constraint posts_poster_type_check
  check (poster_type in ('landlord', 'broker', 'developer', 'buyer', 'tenant', 'host'));
alter table public.posts drop constraint if exists posts_deal_check;
alter table public.posts add constraint posts_deal_check check (deal in ('sale', 'rent', 'share', 'stay'));
alter table public.posts add column if not exists interests jsonb not null default '[]'::jsonb;
alter table public.posts add column if not exists guests int;
alter table public.posts add column if not exists min_nights int;
alter table public.profiles add column if not exists interests jsonb not null default '[]'::jsonb;
update public.profiles set role = 'seeker' where role in ('buyer', 'tenant');

-- Listings a person swiped away ("not for me"): hidden from their map and list until they clear them (safe to re-run).
create table if not exists public.hidden_posts (
  user_id    uuid not null references auth.users(id) on delete cascade,
  post_id    uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
alter table public.hidden_posts enable row level security;
