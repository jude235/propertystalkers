// Price history, views, "report this listing", extra listing details and sold / rented.
// Everything here is safe before supabase/extras.sql has been run: reads fall back to nothing, writes say so.
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ""));
export const REPORT_REASONS = { gone: "No longer available", wrong: "Wrong price or details", fake: "Not a real listing", duplicate: "Posted more than once", location: "Wrong place on the map", other: "Something else" };
const NOT_READY = "This isn't switched on yet. Please try again later.";

/** A link someone typed, kept only if it is an ordinary https web address. */
export function cleanLink(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); return u.protocol === "https:" && u.hostname.includes(".") && s.length <= 300 ? u.href : undefined; }
  catch (e) { return undefined; }
}
/** Check the extra details an owner typed. Returns { fields } or { error }. Empty values clear a field. */
export function cleanExtras(b, now = new Date()) {
  const f = {};
  const blank = (v) => v === null || v === undefined || String(v).trim() === "";
  if ("permit_number" in b) {
    const s = blank(b.permit_number) ? null : String(b.permit_number).trim().replace(/\s+/g, " ");
    if (s && !/^[A-Za-z0-9][A-Za-z0-9 ./-]{2,29}$/.test(s)) return { error: "The permit number should be 3 to 30 letters and numbers." };
    f.permit_number = s;
  }
  const whole = (key, min, max, msg) => {
    if (!(key in b)) return null;
    if (blank(b[key])) { f[key] = null; return null; }
    const n = Number(b[key]);
    if (!Number.isInteger(n) || n < min || n > max) return msg;
    f[key] = n; return null;
  };
  const bad = whole("floor_level", 0, 200, "The floor should be a number from 0 (ground) to 200.") || whole("year_built", 1800, now.getFullYear() + 10, "That year doesn't look right.");
  if (bad) return { error: bad };
  if ("service_charge" in b) {
    if (blank(b.service_charge)) f.service_charge = null;
    else { const n = Number(b.service_charge); if (!Number.isFinite(n) || n < 0 || n > 100000) return { error: "The service charge doesn't look right." }; f.service_charge = Math.round(n * 100) / 100; }
  }
  for (const k of ["video_url", "tour_url"]) if (k in b) { const u = cleanLink(b[k]); if (u === undefined) return { error: "That link doesn't look right. Paste the full web address, starting with https://" }; f[k] = u; }
  return { fields: f };
}
/** The extra details shown on a listing page (only the ones that are filled in). */
export function publicExtras(p) {
  const o = {};
  for (const k of ["permit_number", "floor_level", "year_built", "service_charge", "video_url", "tour_url"]) if (p[k] !== null && p[k] !== undefined && p[k] !== "") o[k] = k === "service_charge" ? Number(p[k]) : p[k];
  return o;
}
/** Remember an asking price. Never stops the caller: the listing matters more than its history. */
export async function notePrice(store, postId, price) {
  if (!postId || !price) return;
  try { await store.insert("price_history", [{ post_id: postId, price }]); } catch (e) {}
}
/** Each listing's asking prices, oldest first: Map(post id -> [{ price, at }]). */
export async function priceHistories(store, ids) {
  const out = new Map();
  if (!ids.length) return out;
  let rows = [];
  try { rows = await store.rows("price_history", { post_id: { in: ids } }, { order: "created_at", asc: true, limit: 5000 }); } catch (e) { return out; }
  for (const r of rows) { const l = out.get(r.post_id) || []; l.push({ price: Number(r.price), at: r.created_at }); out.set(r.post_id, l); }
  return out;
}

export async function extrasRoutes({ path, method, deps, json, readJson, user, isAdmin }) {
  const { store } = deps;
  const m = path.match(/^\/posts\/([^/]+)\/(view|report|extras|close)$/);
  if (m) {
    const [, id, what] = m;
    if (!isUuid(id)) return json({ error: "Not found" }, 404);
    if (what === "view" && method === "POST") {
      const post = await store.getPost(id);
      if (!post || post.status !== "active" || post.kind !== "listing") return json({ ok: false });
      if (user && user.id === post.user_id) return json({ ok: true, own: true });   // your own visits don't count
      try { if (store.bumpViews) await store.bumpViews(id); else await store.updatePost(id, { views: (Number(post.views) || 0) + 1 }); } catch (e) { return json({ ok: false }); }
      return json({ ok: true });
    }
    if (what === "report" && method === "POST") {
      if (!user) return json({ error: "Please sign in to report a listing." }, 401);
      const b = await readJson();
      const reason = String(b.reason || "");
      if (!REPORT_REASONS[reason]) return json({ error: "Please choose what's wrong." }, 400);
      const post = await store.getPost(id);
      if (!post || post.status !== "active") return json({ error: "Not found" }, 404);
      if (post.user_id === user.id) return json({ error: "This is your own listing. You can edit or remove it instead." }, 400);
      try {
        const mine = await store.rows("reports", { post_id: id, user_id: user.id }, { limit: 1 });
        if (!mine.length) await store.insert("reports", [{ post_id: id, user_id: user.id, reason, note: String(b.note || "").trim().slice(0, 500) || null, status: "new" }]);
      } catch (e) { return json({ error: NOT_READY }, 503); }
      return json({ ok: true });
    }
    if (what === "extras" && method === "PATCH") {
      if (!user) return json({ error: "Please sign in." }, 401);
      const post = await store.getPost(id);
      if (!post || post.status === "removed" || post.kind !== "listing") return json({ error: "Not found" }, 404);
      if (post.user_id !== user.id && !isAdmin) return json({ error: "You can only change your own listings." }, 403);
      const v = cleanExtras(await readJson());
      if (v.error) return json({ error: v.error }, 400);
      if (!Object.keys(v.fields).length) return json({ extra: publicExtras(post) });
      let updated;
      try { updated = await store.updatePost(id, v.fields); } catch (e) { return json({ error: NOT_READY }, 503); }
      return json({ extra: publicExtras(updated) });
    }
    if (what === "close" && method === "POST") {
      if (!user) return json({ error: "Please sign in." }, 401);
      const b = await readJson();
      if (!["sold", "rented"].includes(b.as)) return json({ error: "Say whether it was sold or rented." }, 400);
      const post = await store.getPost(id);
      if (!post || post.status === "removed" || post.kind !== "listing") return json({ error: "Not found" }, 404);
      if (post.user_id !== user.id && !isAdmin) return json({ error: "You can only close your own listings." }, 403);
      // The listing comes off the map either way; how it ended is kept when the database has room for it.
      try { await store.updatePost(id, { status: "removed", closed_as: b.as, closed_at: new Date().toISOString() }); }
      catch (e) { await store.setPostStatus(id, "removed"); }
      return json({ ok: true, closed_as: b.as });
    }
  }
  if (path === "/admin/reports" && method === "GET") {
    if (!isAdmin) return json({ error: "Admins only." }, 403);
    let rows = [];
    try { rows = await store.rows("reports", {}, { order: "created_at", limit: 200 }); } catch (e) {}
    return json({ reports: rows.map((r) => ({ id: r.id, post_id: r.post_id, reason: REPORT_REASONS[r.reason] || r.reason, note: r.note, status: r.status, created_at: r.created_at })) });
  }
  return null;
}
