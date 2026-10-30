-- ===================== Fast map: load only what's in view (safe to re-run) =====================
-- The map asks for one rectangle (west, south, east, north) plus the chosen chips and filters.
-- Zoomed in: map_pins returns the listings themselves (a few hundred at most).
-- Zoomed out: map_clusters returns counts per grid square, so the browser never downloads thousands of pins.

-- Location index: finds everything inside a rectangle without reading the whole table.
create index if not exists posts_geo_gist on public.posts using gist (point(lng, lat)) where status = 'active';
-- Common filters.
create index if not exists posts_active_deal_idx on public.posts (kind, deal) where status = 'active';
create index if not exists posts_active_price_idx on public.posts (price) where status = 'active';
create index if not exists posts_active_created_idx on public.posts (created_at desc) where status = 'active';
create index if not exists hidden_posts_user_idx on public.hidden_posts (user_id);

-- f (jsonb): w s e n, kind ('listing' | 'request'), deals [], cat_dev bool, cat_types [], types [], beds, pmin, pmax,
-- smin, smax, by [], amen [], photos bool, me (uuid), req_scope ('all' | 'share' | 'own'), lim, cell
create or replace function public.map_where(p public.posts, f jsonb) returns boolean
language sql stable parallel safe as $$
  select
    p.kind = coalesce(f->>'kind', 'listing')
    -- Chips add up: a listing shows if it matches any chosen deal or any chosen category.
    and (
      ((f->'deals' is null or jsonb_array_length(f->'deals') = 0)
        and coalesce((f->>'cat_dev')::boolean, false) = false and (f->'cat_types' is null or jsonb_array_length(f->'cat_types') = 0))
      or (f->'deals' is not null and (f->'deals') ? p.deal)
      or (coalesce((f->>'cat_dev')::boolean, false) and p.poster_type = 'developer')
      or (f->'cat_types' is not null and (f->'cat_types') ? coalesce(p.property_type, ''))
    )
    and (f->'types' is null or jsonb_array_length(f->'types') = 0 or (f->'types') ? coalesce(p.property_type, ''))
    and (f->>'beds' is null or greatest(coalesce(p.bedrooms, 0), 0) >= (f->>'beds')::int)
    and (f->>'pmin' is null or p.price >= (f->>'pmin')::numeric)
    and (f->>'pmax' is null or p.price <= (f->>'pmax')::numeric)
    and (f->>'smin' is null or p.size_sqft >= (f->>'smin')::numeric)
    and (f->>'smax' is null or p.size_sqft <= (f->>'smax')::numeric)
    and (f->'by' is null or jsonb_array_length(f->'by') = 0 or (f->'by') ? p.poster_type)
    and (f->'amen' is null or jsonb_array_length(f->'amen') = 0 or coalesce(p.amenities, '[]'::jsonb) @> (f->'amen'))
    and (coalesce((f->>'photos')::boolean, false) = false or jsonb_array_length(coalesce(p.photos, '[]'::jsonb)) > 0)
    -- Listed within N days / on the market over N days
    and (f->>'maxage' is null or p.created_at >= now() - ((f->>'maxage')::int * interval '1 day'))
    and (f->>'minage' is null or p.created_at <= now() - ((f->>'minage')::int * interval '1 day'))
    -- Price reduced since first posted
    and (coalesce((f->>'cut')::boolean, false) = false or (p.first_price is not null and p.price is not null and p.price < p.first_price))
    -- Price per sq ft
    and (f->>'ppmin' is null or (p.size_sqft > 0 and p.price is not null and p.price::numeric / p.size_sqft >= (f->>'ppmin')::numeric))
    and (f->>'ppmax' is null or (p.size_sqft > 0 and p.price is not null and p.price::numeric / p.size_sqft <= (f->>'ppmax')::numeric))
    -- Keywords: every word must appear in the description, building, area or city
    and (f->'words' is null or jsonb_array_length(f->'words') = 0 or not exists (
      select 1 from jsonb_array_elements_text(f->'words') w
      where (coalesce(p.description, '') || ' ' || coalesce(p.building, '') || ' ' || coalesce(p.locality, '') || ' ' || coalesce(p.city, '')) not ilike '%' || w || '%'))
    and (
      p.kind = 'listing'
      or coalesce(f->>'req_scope', 'own') = 'all'
      or (f->>'req_scope' = 'share' and p.deal = 'share')
      or (f->>'me' is not null and p.user_id = (f->>'me')::uuid)
    )
$$;

-- Listings inside the rectangle (newest first), skipping ones this person hid.
create or replace function public.map_pins(f jsonb) returns setof public.posts
language sql stable parallel safe as $$
  select p.* from public.posts p
  where p.status = 'active'
    and point(p.lng, p.lat) <@ box(point((f->>'w')::float8, (f->>'s')::float8), point((f->>'e')::float8, (f->>'n')::float8))
    and public.map_where(p, f)
    and (f->>'me' is null or not exists (select 1 from public.hidden_posts h where h.user_id = (f->>'me')::uuid and h.post_id = p.id))
  order by p.created_at desc
  limit least(coalesce((f->>'lim')::int, 400), 1000)
$$;

-- Counts per grid square (cell = square size in degrees), with the average position of what's inside.
create or replace function public.map_clusters(f jsonb) returns table (lat float8, lng float8, n bigint)
language sql stable parallel safe as $$
  select avg(p.lat), avg(p.lng), count(*)
  from public.posts p
  where p.status = 'active'
    and point(p.lng, p.lat) <@ box(point((f->>'w')::float8, (f->>'s')::float8), point((f->>'e')::float8, (f->>'n')::float8))
    and public.map_where(p, f)
  group by floor(p.lat / (f->>'cell')::float8), floor(p.lng / (f->>'cell')::float8)
  limit 2000
$$;

-- Only the server (service role) calls these; the public and signed-in keys can't.
revoke execute on function public.map_pins(jsonb) from public, anon, authenticated;
revoke execute on function public.map_clusters(jsonb) from public, anon, authenticated;
revoke execute on function public.map_where(public.posts, jsonb) from public, anon, authenticated;
grant execute on function public.map_pins(jsonb) to service_role;
grant execute on function public.map_clusters(jsonb) to service_role;
grant execute on function public.map_where(public.posts, jsonb) to service_role;

-- Dots for the zoomed-out map: one row per listing, position and colour only (skips listings this person hid).
create or replace function public.map_dots(f jsonb) returns table (lat float8, lng float8, deal text, dev boolean, kind text)
language sql stable parallel safe as $$
  select p.lat, p.lng, p.deal, p.poster_type = 'developer', p.kind
  from public.posts p
  where p.status = 'active'
    and point(p.lng, p.lat) <@ box(point((f->>'w')::float8, (f->>'s')::float8), point((f->>'e')::float8, (f->>'n')::float8))
    and public.map_where(p, f)
    and (f->>'me' is null or not exists (select 1 from public.hidden_posts h where h.user_id = (f->>'me')::uuid and h.post_id = p.id))
  limit least(coalesce((f->>'lim')::int, 5000), 20000)
$$;
revoke execute on function public.map_dots(jsonb) from public, anon, authenticated;
grant execute on function public.map_dots(jsonb) to service_role;
