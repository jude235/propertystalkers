-- =====================================================================
-- Property Stalkers: price history, views, reports, extra listing details, sold / rented.
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- It only ADDS columns and tables. Nothing existing is changed or deleted. Safe to run more than once.
-- =====================================================================

-- Extra details an owner can add to a listing.
alter table public.posts add column if not exists permit_number  text;      -- advertising permit (Trakheesi / ADREC / RERA project no.)
alter table public.posts add column if not exists floor_level    int;       -- 0 = ground
alter table public.posts add column if not exists year_built     int;
alter table public.posts add column if not exists service_charge numeric;   -- per sq ft per year, in the listing's currency
alter table public.posts add column if not exists video_url      text;
alter table public.posts add column if not exists tour_url       text;      -- 3D / virtual tour
-- How a listing ended, and how often it has been opened.
alter table public.posts add column if not exists closed_as text;           -- 'sold' or 'rented'
alter table public.posts add column if not exists closed_at timestamptz;
alter table public.posts add column if not exists views int not null default 0;

-- Every asking price a listing has had, oldest first.
create table if not exists public.price_history (
  id         bigint generated always as identity primary key,
  post_id    uuid not null references public.posts(id) on delete cascade,
  price      bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists price_history_post_idx on public.price_history (post_id, created_at);
-- Start each listing's history from what is already known: its first price, then today's price if it changed.
insert into public.price_history (post_id, price, created_at)
  select p.id, coalesce(p.first_price, p.price), p.created_at from public.posts p
  where p.kind = 'listing' and coalesce(p.first_price, p.price) is not null
    and not exists (select 1 from public.price_history h where h.post_id = p.id);
insert into public.price_history (post_id, price, created_at)
  select p.id, p.price, coalesce(p.price_changed_at, now()) from public.posts p
  where p.kind = 'listing' and p.price is not null and p.first_price is not null and p.first_price <> p.price
    and (select count(*) from public.price_history h where h.post_id = p.id) = 1;

-- "Report this listing" from visitors.
create table if not exists public.reports (
  id         bigint generated always as identity primary key,
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  reason     text not null,
  note       text,
  status     text not null default 'new',
  created_at timestamptz not null default now()
);
create index if not exists reports_post_idx on public.reports (post_id);

-- One more view for a listing.
create or replace function public.bump_views(pid uuid) returns int
language sql as $$
  update public.posts set views = views + 1 where id = pid returning views;
$$;
revoke execute on function public.bump_views(uuid) from public, anon, authenticated;

-- Locked like every other table: browsers cannot read or write these directly.
alter table public.price_history enable row level security;
alter table public.reports enable row level security;
