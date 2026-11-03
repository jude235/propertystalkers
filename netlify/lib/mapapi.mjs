// The fast map. The browser asks only for the area on screen; the server answers with
//   - pins (lean: what a marker and a list card need), when there are few enough to show, or
//   - counts per grid square ("clusters"), when zoomed out over busy areas.
// Full details (description, contact, warnings) come from GET /posts/<id> when someone opens a listing.
import { DEALS, PROPERTY_TYPES, COMMERCIAL_TYPES, AMENITIES, isUuid, clean, collapseUnits, canSee, accessSummary, toPublic } from "./core.mjs";
import { marketInfo, FLAG_TEXT, PUBLIC_FLAGS } from "./market.mjs";
import { attachEnv, fillEnv } from "./envq.mjs";

/** More pins than this in view -> send counts per area instead. */
export const PIN_LIMIT = 300;
/** Below this zoom level, always send counts (a whole country or continent is in view). */
export const PIN_MIN_ZOOM = 9;
/** Zoomed out, the new map look asks for one tiny dot per listing (position and colour only), up to this many. */
export const DOT_LIMIT = 5000;
/** Dot colour code: s sale, r rent, c co-living, h holiday home, n new project, q request. */
const dotCode = (d) => (d.kind === "request" ? "q" : d.dev ? "n" : ({ sale: "s", rent: "r", share: "c", stay: "h" })[d.deal] || "s");

/** Read the visible area, the chips and the filters from the request. Returns null if the area is missing or bad. */
export function mapFilter(url, viewer) {
  const q = (k) => url.searchParams.get(k);
  const num = (k, min, max) => {
    const raw = q(k);
    if (raw === null || raw === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min && v <= max ? v : null;
  };
  const list = (k, allowed) => [...new Set(String(q(k) || "").split(",").map((x) => x.trim()).filter((x) => allowed.includes(x)))];
  const w = num("w", -180, 180), e = num("e", -180, 180), s = num("s", -90, 90), n = num("n", -90, 90);
  if ([w, e, s, n].some((v) => v === null) || s >= n) return null;
  const z = num("z", 0, 22) ?? 10;
  const cats = list("cats", ["project", "commercial", "land"]);
  return {
    w, e, s, n, z,
    kind: q("kind") === "request" ? "request" : "listing",
    deals: list("deals", DEALS),
    cat_dev: cats.includes("project") || null,
    cat_types: [...(cats.includes("commercial") ? COMMERCIAL_TYPES : []), ...(cats.includes("land") ? ["plot"] : [])],
    types: list("types", PROPERTY_TYPES),
    beds: num("beds", 1, 20),
    pmin: num("pmin", 0, 1e12), pmax: num("pmax", 0, 1e12),
    smin: num("smin", 0, 1e9), smax: num("smax", 0, 1e9),
    by: list("by", ["landlord", "broker", "developer", "host"]),
    amen: list("amen", AMENITIES),
    photos: q("photos") === "1" || null,
    // Listed within N days ("1", "7", "30"), or on the market for over 90 days ("90+").
    maxage: ["1", "7", "30"].includes(q("age")) ? Number(q("age")) : null,
    minage: q("age") === "90+" ? 90 : null,
    cut: q("cut") === "1" || null,
    ppmin: num("ppmin", 0, 1e9), ppmax: num("ppmax", 0, 1e9),
    words: keywords(q("q")),
    me: viewer ? viewer.id : null,
    req_scope: viewer && (viewer.isAdmin || viewer.isBroker) ? "all" : viewer && viewer.sharesSpace ? "share" : "own",
    // Grid square size for counts: about a quarter of a map tile at this zoom.
    cell: 360 / Math.pow(2, Math.round(z)) / 4
  };
}

/** Free-text keywords: up to 5 plain words (letters, digits, dashes), each at least 2 characters. */
export function keywords(raw) {
  const w = String(raw || "").toLowerCase().normalize("NFKC").split(/\s+/).map((x) => x.replace(/[^\p{L}\p{N}-]/gu, "")).filter((x) => x.length >= 2);
  return [...new Set(w)].slice(0, 5);
}

/** One rectangle, or two when the view crosses the date line. */
const boxes = (f) => (f.w <= f.e ? [f] : [{ ...f, e: 180 }, { ...f, w: -180 }]);
const dbF = (f, extra = {}) => { const { z, ...rest } = f; return { ...rest, ...extra }; };

/** What a marker and a list card need. */
export function toPin(p, viewer, i = {}, watched = new Set()) {
  const photos = Array.isArray(p.photos) ? p.photos : [];
  const dev = p.poster_type === "developer";
  return {
    id: p.id, kind: p.kind, poster_type: p.poster_type, deal: p.deal, property_type: p.property_type, bedrooms: p.bedrooms,
    price: p.price, currency: p.currency || "INR", building: p.building, locality: p.locality, city: p.city, country: p.country,
    lat: p.lat, lng: p.lng, room_type: p.room_type || null, suits: p.suits || null, guests: p.guests ?? null,
    interests: Array.isArray(p.interests) ? p.interests : [], amenities: Array.isArray(p.amenities) ? p.amenities : [],
    size_sqft: p.size_sqft ?? null, configs: dev ? p.configs || null : null, company: dev ? p.company || null : null,
    possession: dev ? p.possession || null : null,
    // All photo links (just short strings), so swiping a card's photos never waits for the full details.
    photo: photos[0] || null, nphotos: photos.length, photos: photos.slice(0, 8),
    created_at: p.created_at,
    mine: !!viewer && p.user_id === viewer.id,
    watched: watched.has(p.id),
    below_market_pct: i.below_pct >= 5 ? i.below_pct : 0,
    price_cut_pct: i.cut_pct || 0,
    good_deal: !!i.deal
  };
}

async function watchedSet(store, viewer, ids) {
  if (!viewer || !ids.length) return new Set();
  return new Set((await store.rows("watches", { user_id: viewer.id, post_id: { in: ids } }, { limit: 1000 })).map((w) => w.post_id));
}

/** Rows from the database -> pins the viewer may see (one per unit, cheapest first). */
export async function pinsFor(store, rows, viewer, { collapse = true } = {}) {
  const visible = (collapse ? collapseUnits(rows, viewer) : rows).filter((p) => canSee(p, viewer));
  const info = marketInfo(rows);
  const watched = await watchedSet(store, viewer, visible.map((p) => p.id));
  return visible.map((p) => toPin(p, viewer, info.get(p.id) || {}, watched));
}

/** Most listings sent in full by one /posts/details call. */
export const DETAILS_MAX = 40;

/**
 * Full details for listings the viewer may see (already checked), in two rounds of database calls at most:
 * nearby prices (for the "below market" and "price cut" notes), pictures of the posters, the viewer's
 * shortlist and hidden marks, and the area's air and noise, all at the same time.
 */
async function fullDetails(store, posts, viewer, deps, later) {
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  // Nearby prices: one query per deal and ~10 km area, however many listings are in it.
  const groups = new Map();
  for (const p of posts) {
    if (p.lat == null || p.lng == null) continue;
    const k = `${p.deal}|${Math.floor(p.lat * 10)}|${Math.floor(p.lng * 10)}`;
    const g = groups.get(k) || { deal: p.deal, w: Infinity, e: -Infinity, s: Infinity, n: -Infinity };
    g.w = Math.min(g.w, p.lng - 0.05); g.e = Math.max(g.e, p.lng + 0.05); g.s = Math.min(g.s, p.lat - 0.05); g.n = Math.max(g.n, p.lat + 0.05);
    groups.set(k, g);
  }
  const spots = posts.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng }));
  const [nearLists, avatars, watchedRows, hiddenRows, missingEnv] = await Promise.all([
    Promise.all([...groups.values()].map((g) => store.mapPins({ w: g.w, e: g.e, s: g.s, n: g.n, kind: "listing", deals: [g.deal], lim: 400 }).catch(() => []))),
    store.avatarsFor([...new Set(posts.map((p) => p.user_id))]),
    viewer ? store.rows("watches", { user_id: viewer.id, post_id: { in: ids } }, { limit: 1000 }) : [],
    viewer ? store.rows("hidden_posts", { user_id: viewer.id, post_id: { in: ids } }, { limit: 1000 }) : [],
    attachEnv(store, spots).catch(() => [])
  ]);
  const near = new Map();
  for (const r of nearLists.flat()) near.set(r.id, r);
  for (const p of posts) if (!near.has(p.id)) near.set(p.id, p);
  const info = marketInfo([...near.values()]);
  const watched = new Set(watchedRows.map((w) => w.post_id)), hidden = new Set(hiddenRows.map((h) => h.post_id));
  const out = posts.map((p, k) => {
    const i = info.get(p.id) || {};
    const o = toPublic({ ...p, contact_avatar: avatars[p.user_id] || null }, viewer);
    const insider = viewer && (viewer.id === p.user_id || viewer.isAdmin);
    const flags = [...(Array.isArray(p.flags) ? p.flags : []), ...(i.below_pct >= 40 ? ["far_below_market"] : [])];
    o.below_market_pct = i.below_pct >= 5 ? i.below_pct : 0;
    o.price_cut_pct = i.cut_pct || 0;
    o.good_deal = !!i.deal;
    o.warnings = flags.filter((x) => insider || PUBLIC_FLAGS.includes(x)).map((x) => FLAG_TEXT[x]).filter(Boolean);
    o.watched = watched.has(p.id);
    o.hidden = hidden.has(p.id);
    o.cobroke = !!p.cobroke && (insider || !!(viewer && viewer.isBroker));
    o.needs_confirm = !!(insider && p.stale_notified_at);
    o.nphotos = o.photos.length;
    o.photo = o.photos[0] || null;
    if (spots[k].env) o.env = spots[k].env;
    return o;
  });
  if (missingEnv.length && deps.envq && later) await later(() => fillEnv(store, deps.envq, missingEnv));
  return out;
}

async function countIn(store, f) {
  const parts = await Promise.all(boxes(f).map((b) => store.mapClusters(dbF(b, { cell: 360 }))));
  return parts.flat().reduce((t, c) => t + Number(c.n), 0);
}

export async function mapRoutes(c) {
  const { path, method, url, deps, json, readJson, loadViewer, user, later, maybeRunJobs } = c;
  const { store } = deps;
  // Area air and noise from the cache; any missing areas are looked up after the reply.
  const withEnv = async (pins) => {
    const missing = await attachEnv(store, pins);
    if (missing.length && deps.envq && later) await later(() => fillEnv(store, deps.envq, missing));
    return pins;
  };

  /* ---------- the map: pins or counts for the visible area ---------- */
  if (path === "/map" && method === "GET") {
    const { viewer } = await loadViewer();
    const f = mapFilter(url, viewer);
    if (!f) return json({ error: "Please send the map area (w, s, e, n)." }, 400);
    const mode = url.searchParams.get("mode");
    const base = { access: accessSummary(viewer), signedIn: !!viewer };
    if (mode === "count") return json({ ...base, total: await countIn(store, f) });

    // The list asks for the newest few in view even when the map is showing counts.
    if (mode === "list") {
      const lim = Math.min(Math.max(Number(url.searchParams.get("lim")) || 30, 1), 60);
      const rows = (await Promise.all(boxes(f).map((b) => store.mapPins(dbF(b, { lim }))))).flat();
      return json({ ...base, mode: "pins", pins: await withEnv(await pinsFor(store, rows, viewer)), total: await countIn(store, f) });
    }

    const minZoom = Number.isFinite(Number(deps.env && deps.env.MAP_PIN_MIN_ZOOM)) && deps.env.MAP_PIN_MIN_ZOOM !== "" ? Number(deps.env.MAP_PIN_MIN_ZOOM) : PIN_MIN_ZOOM;
    if (f.z >= minZoom) {
      const rows = (await Promise.all(boxes(f).map((b) => store.mapPins(dbF(b, { lim: PIN_LIMIT + 1 }))))).flat();
      if (rows.length <= PIN_LIMIT) {
        const pins = await withEnv(await pinsFor(store, rows, viewer));
        if (later && maybeRunJobs) await later(() => maybeRunJobs(deps));
        return json({ ...base, mode: "pins", pins, total: pins.length });
      }
    }
    // Dots: every listing as a tiny coloured dot (a few bytes each), when there aren't too many.
    if (url.searchParams.get("dots") === "1" && store.mapDots) {
      const rows = (await Promise.all(boxes(f).map((b) => store.mapDots(dbF(b, { lim: DOT_LIMIT + 1 }))))).flat();
      if (rows.length <= DOT_LIMIT) {
        const dots = rows.map((d) => [Math.round(d.lat * 1e5) / 1e5, Math.round(d.lng * 1e5) / 1e5, dotCode({ ...d, kind: d.kind || f.kind })]);
        if (later && maybeRunJobs) await later(() => maybeRunJobs(deps));
        return json({ ...base, mode: "dots", dots, total: dots.length });
      }
    }
    const clusters = (await Promise.all(boxes(f).map((b) => store.mapClusters(dbF(b))))).flat()
      .map((x) => ({ lat: Number(x.lat), lng: Number(x.lng), n: Number(x.n) }));
    if (later && maybeRunJobs) await later(() => maybeRunJobs(deps));
    return json({ ...base, mode: "clusters", clusters, total: clusters.reduce((t, x) => t + x.n, 0) });
  }

  /* ---------- one listing in full (when it's opened) ---------- */
  const one = path.match(/^\/posts\/([^/]+)$/);
  if (one && method === "GET") {
    if (!isUuid(one[1])) return json({ error: "Not found" }, 404);
    // Who is asking and the listing itself, at the same time (each trip to the database takes a while).
    const [{ viewer }, p] = await Promise.all([loadViewer(), store.getPost(one[1])]);
    if (!p || !canSee(p, viewer)) return json({ error: "This listing isn't available any more." }, 404);
    const [out] = await fullDetails(store, [p], viewer, deps, later);
    return json({ post: out });
  }

  /* ---------- full details of many listings in one go ----------
     The app asks for these as soon as a list or a map card appears, so tapping a listing opens it at once
     instead of waiting on the database (which may be far away). */
  if (path === "/posts/details" && method === "POST") {
    const b = await readJson(c.req);
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).filter(isUuid))].slice(0, DETAILS_MAX);
    if (!ids.length) return json({ posts: [] });
    const [{ viewer }, rows] = await Promise.all([loadViewer(), store.postsFull(ids)]);
    const seen = rows.filter((p) => canSee(p, viewer));
    const order = new Map(ids.map((id, k) => [id, k]));
    const posts = (await fullDetails(store, seen, viewer, deps, later)).sort((x, y) => order.get(x.id) - order.get(y.id));
    return json({ posts });
  }

  /* ---------- several listings by id (shortlist on this device, Stalker's cards) ---------- */
  if (path === "/posts/batch" && method === "POST") {
    const { viewer } = await loadViewer();
    const b = await readJson(c.req);
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).filter(isUuid))].slice(0, 100);
    const rows = await store.postsByIds(ids);
    const order = new Map(ids.map((id, k) => [id, k]));
    const pins = (await pinsFor(store, rows, viewer, { collapse: false })).sort((x, y) => order.get(x.id) - order.get(y.id));
    return json({ pins: await withEnv(pins) });
  }

  /* ---------- search by building, area, city or developer ---------- */
  if (path === "/search" && method === "GET") {
    const { viewer } = await loadViewer();
    const q = clean(url.searchParams.get("q"), 60);
    const kind = url.searchParams.get("kind") === "request" ? "request" : "listing";
    if (!q || q.length < 2) return json({ pins: [] });
    let rows = await store.searchPosts(q, kind, 40);
    if (viewer) {
      const hidden = new Set((await store.rows("hidden_posts", { user_id: viewer.id, post_id: { in: rows.map((r) => r.id) } })).map((h) => h.post_id));
      rows = rows.filter((r) => !hidden.has(r.id));
    }
    return json({ pins: await withEnv((await pinsFor(store, rows, viewer)).slice(0, 20)) });
  }

  /* ---------- the signed-in person's shortlist, and their own posts ---------- */
  if (path === "/shortlist" && method === "GET") {
    if (!user) return json({ error: "Please sign in." }, 401);
    const { viewer } = await loadViewer();
    const ids = (await store.rows("watches", { user_id: user.id }, { order: "created_at", asc: false, limit: 300 })).map((w) => w.post_id);
    const rows = await store.postsByIds(ids);
    const order = new Map(ids.map((id, k) => [id, k]));
    return json({ pins: await withEnv((await pinsFor(store, rows, viewer, { collapse: false })).sort((x, y) => order.get(x.id) - order.get(y.id))) });
  }
  if (path === "/me/posts" && method === "GET") {
    if (!user) return json({ error: "Please sign in." }, 401);
    const { viewer } = await loadViewer();
    const mine = (await store.postsByUser(user.id)).filter((p) => p.status === "active")
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return json({ posts: mine.map((p) => ({ ...toPublic(p, viewer), mine: true })) });
  }
  return null;
}
