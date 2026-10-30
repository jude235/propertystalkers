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
    me: viewer ? viewer.id : null,
    req_scope: viewer && (viewer.isAdmin || viewer.isBroker) ? "all" : viewer && viewer.sharesSpace ? "share" : "own",
    // Grid square size for counts: about a quarter of a map tile at this zoom.
    cell: 360 / Math.pow(2, Math.round(z)) / 4
  };
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
    const clusters = (await Promise.all(boxes(f).map((b) => store.mapClusters(dbF(b))))).flat()
      .map((x) => ({ lat: Number(x.lat), lng: Number(x.lng), n: Number(x.n) }));
    if (later && maybeRunJobs) await later(() => maybeRunJobs(deps));
    return json({ ...base, mode: "clusters", clusters, total: clusters.reduce((t, x) => t + x.n, 0) });
  }

  /* ---------- one listing in full (when it's opened) ---------- */
  const one = path.match(/^\/posts\/([^/]+)$/);
  if (one && method === "GET") {
    if (!isUuid(one[1])) return json({ error: "Not found" }, 404);
    const { viewer } = await loadViewer();
    const p = await store.getPost(one[1]);
    if (!p || !canSee(p, viewer)) return json({ error: "This listing isn't available any more." }, 404);
    // Everything else this page needs, fetched at the same time (each trip to the database takes a while).
    const [near, avatars, watchedRows, hiddenRows] = await Promise.all([
      p.lat == null ? [] : store.mapPins({ w: p.lng - 0.05, e: p.lng + 0.05, s: p.lat - 0.05, n: p.lat + 0.05, kind: "listing", deals: [p.deal], lim: 400 }),
      store.avatarsFor([p.user_id]),
      viewer ? store.rows("watches", { user_id: viewer.id, post_id: p.id }) : [],
      viewer ? store.rows("hidden_posts", { user_id: viewer.id, post_id: p.id }) : []
    ]);
    const info = marketInfo(near.some((x) => x.id === p.id) ? near : [...near, p]).get(p.id) || {};
    p.contact_avatar = avatars[p.user_id] || null;
    const out = toPublic(p, viewer);
    const insider = viewer && (viewer.id === p.user_id || viewer.isAdmin);
    const flags = [...(Array.isArray(p.flags) ? p.flags : []), ...(info.below_pct >= 40 ? ["far_below_market"] : [])];
    out.below_market_pct = info.below_pct >= 5 ? info.below_pct : 0;
    out.price_cut_pct = info.cut_pct || 0;
    out.good_deal = !!info.deal;
    out.warnings = flags.filter((x) => insider || PUBLIC_FLAGS.includes(x)).map((x) => FLAG_TEXT[x]).filter(Boolean);
    out.watched = watchedRows.length > 0;
    out.hidden = hiddenRows.length > 0;
    out.cobroke = !!p.cobroke && (insider || !!(viewer && viewer.isBroker));
    out.needs_confirm = !!(insider && p.stale_notified_at);
    out.nphotos = out.photos.length;
    out.photo = out.photos[0] || null;
    await withEnv([out]);
    return json({ post: out });
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
