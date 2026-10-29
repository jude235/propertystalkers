// In-memory stand-ins for Supabase, the AI and Google, used by the tests.
import { randomUUID } from "node:crypto";
import { coordsFromMapsUrl } from "../netlify/lib/geo.mjs";

export function memoryStore() {
  const users = new Map();     // token -> { id, email }
  const profiles = new Map();
  const posts = [];
  const drafts = new Map();
  const usage = new Map();
  const tables = { posts };
  const tbl = (name) => (name === "profiles" ? [...profiles.values()] : (tables[name] ||= []));
  const ok = (row, where) => Object.entries(where).every(([k, v]) => {
    const x = row[k];
    if (v === null) return x == null;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("in" in v && !v.in.includes(x)) return false;
      if ("lt" in v && !(x < v.lt)) return false;
      if ("lte" in v && !(x <= v.lte)) return false;
      if ("gt" in v && !(x > v.gt)) return false;
      if ("gte" in v && !(x >= v.gte)) return false;
      if ("not" in v && (v.not === null ? x == null : x === v.not)) return false;
      return true;
    }
    return x === v;
  });
  const DEFAULTS = {
    posts: () => ({ flags: [], cobroke: false, confirmed_at: new Date().toISOString() }),
    notifications: () => ({ read_at: null }),
    enquiries: () => ({ status: "new", reminded: false }),
    tenancies: () => ({ renewal_reminded: false, rent_reminded_for: null })
  };
  return {
    _users: users, _posts: posts, _profiles: profiles, _tables: tables,
    async rows(table, where = {}, { order, asc = false, limit } = {}) {
      let r = tbl(table).filter((x) => ok(x, where));
      if (order) r = [...r].sort((a, b) => (a[order] > b[order] ? 1 : a[order] < b[order] ? -1 : 0) * (asc ? 1 : -1));
      return (limit ? r.slice(0, limit) : r).map((x) => ({ ...x }));
    },
    async insert(table, rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      const out = list.map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...(DEFAULTS[table] ? DEFAULTS[table]() : {}), ...r }));
      tbl(table).push(...out);
      return out.map((x) => ({ ...x }));
    },
    async update(table, where, patch) {
      const hit = tbl(table).filter((x) => ok(x, where));
      hit.forEach((x) => Object.assign(x, patch));
      return hit.map((x) => ({ ...x }));
    },
    async remove(table, where) {
      const t = tbl(table);
      for (let i = t.length - 1; i >= 0; i--) if (ok(t[i], where)) t.splice(i, 1);
    },
    addUser(email) { const u = { id: randomUUID(), email }; users.set("tok-" + email, u); return { ...u, token: "tok-" + email }; },
    async getUser(t) { return users.get(t) || null; },
    async getProfile(id) { return profiles.get(id) || null; },
    async upsertProfile(p) { const v = { ...(profiles.get(p.id) || {}), ...p }; profiles.set(p.id, v); return v; },
    _leads: [], _leadCount: new Map(),
    async activeByUnitKey(key) { return posts.filter((p) => p.status === "active" && p.unit_key === key); },
    async nextLead(key) { const n = (this._leadCount.get(key) || 0) + 1; this._leadCount.set(key, n); return n; },
    async logLead(l) { this._leads.push(l); },
    async avatarsFor(ids) { const o = {}; for (const id of ids) { const p = profiles.get(id); if (p && p.avatar_url) o[id] = p.avatar_url; } return o; },
    async activePosts() { return posts.filter((p) => p.status === "active"); },
    // Same rules as the SQL functions in supabase/map.sql.
    async mapPins(f) {
      const hidden = f.me ? new Set(tbl("hidden_posts").filter((h) => h.user_id === f.me).map((h) => h.post_id)) : new Set();
      return posts.filter((p) => p.status === "active" && inBox(p, f) && mapWhere(p, f) && !hidden.has(p.id))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Math.min(f.lim || 400, 1000)).map((p) => ({ ...p }));
    },
    async mapClusters(f) {
      const cells = new Map();
      for (const p of posts) {
        if (!(p.status === "active" && inBox(p, f) && mapWhere(p, f))) continue;
        const k = Math.floor(p.lat / f.cell) + ":" + Math.floor(p.lng / f.cell);
        const c = cells.get(k) || { lat: 0, lng: 0, n: 0 };
        c.lat += p.lat; c.lng += p.lng; c.n++; cells.set(k, c);
      }
      return [...cells.values()].map((c) => ({ lat: c.lat / c.n, lng: c.lng / c.n, n: c.n }));
    },
    async postsByIds(ids) { return posts.filter((p) => ids.includes(p.id) && p.status === "active").map((p) => ({ ...p })); },
    async searchPosts(q, kind, limit = 20) {
      const s = String(q || "").toLowerCase().trim();
      if (s.length < 2) return [];
      return posts.filter((p) => p.status === "active" && p.kind === kind && [p.building, p.locality, p.city, p.company].some((x) => String(x || "").toLowerCase().includes(s))).slice(0, limit);
    },
    async sitemapRows() { return posts.filter((p) => p.status === "active" && p.kind === "listing"); },
    async postsByUser(uid) { return posts.filter((p) => p.user_id === uid); },
    async getPost(id) { return posts.find((p) => p.id === id) || null; },
    async createPost(p) { const v = { id: randomUUID(), created_at: new Date().toISOString(), ...DEFAULTS.posts(), ...p }; posts.push(v); return v; },
    async createPosts(list) { return list.map((p) => { const v = { id: randomUUID(), created_at: new Date().toISOString(), ...p }; posts.push(v); return { id: v.id }; }); },
    async existingBuildingKeys(keys) { return posts.filter((p) => p.status === "active" && keys.includes(p.building_key)).map((p) => p.building_key); },
    async updatePost(id, patch) { const p = posts.find((x) => x.id === id); Object.assign(p, patch); return p; },
    async setPostStatus(id, status) { const p = posts.find((x) => x.id === id); if (p) p.status = status; },
    async countPostsSince(uid, since) { return posts.filter((p) => p.user_id === uid && p.created_at >= since).length; },
    async createDraft(uid, data) { const id = randomUUID(); drafts.set(id, { uid, data }); return id; },
    async updateDraft(id, uid, data) { const d = drafts.get(id); if (d && d.uid === uid) d.data = data; },
    async getDraft(id, uid) { const d = drafts.get(id); return d && d.uid === uid ? d.data : null; },
    async deleteDraft(id) { drafts.delete(id); },
    async bumpAiUsage(uid) { const n = (usage.get(uid) || 0) + 1; usage.set(uid, n); return n; }
  };
}

/** AI that returns whatever the test queued next. */
function inBox(p, f) {
  if (p.lat == null || p.lng == null) return false;
  return p.lat >= f.s && p.lat <= f.n && p.lng >= f.w && p.lng <= f.e;
}
function mapWhere(p, f) {
  const has = (a, v) => !Array.isArray(a) || !a.length || a.includes(v);
  if (p.kind !== (f.kind || "listing")) return false;
  if (!has(f.deals, p.deal)) return false;
  const catOn = !!f.cat_dev || (Array.isArray(f.cat_types) && f.cat_types.length);
  if (catOn && !((f.cat_dev && p.poster_type === "developer") || (f.cat_types || []).includes(p.property_type || ""))) return false;
  if (!has(f.types, p.property_type || "")) return false;
  if (f.beds != null && !(Math.max(p.bedrooms || 0, 0) >= f.beds)) return false;
  if (f.pmin != null && !(p.price >= f.pmin)) return false;
  if (f.pmax != null && !(p.price <= f.pmax)) return false;
  if (f.smin != null && !(p.size_sqft >= f.smin)) return false;
  if (f.smax != null && !(p.size_sqft <= f.smax)) return false;
  if (!has(f.by, p.poster_type)) return false;
  if (Array.isArray(f.amen) && f.amen.length && !f.amen.every((a) => (p.amenities || []).includes(a))) return false;
  if (f.photos && !(Array.isArray(p.photos) && p.photos.length)) return false;
  if (p.kind !== "listing") {
    const scope = f.req_scope || "own";
    if (!(scope === "all" || (scope === "share" && p.deal === "share") || (f.me && p.user_id === f.me))) return false;
  }
  return true;
}

export function scriptedAI() {
  const queue = [];
  return {
    queue, calls: [], roles: [],
    chatQueue: [], chatCalls: [],
    /** Assistant calls: each queued item is a list of content blocks (text / tool_use). */
    async chat(req) { this.chatCalls.push(req); const c = this.chatQueue.shift() || [{ type: "text", text: "ok" }]; return { content: c, stopReason: c.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" }; },
    async converse(messages, opts = {}) { this.calls.push(messages); this.roles.push(opts.role); return queue.shift() || { text: "ok", proposal: null }; }
  };
}

/** Geocoder with a fixed lookup table. */
export function tableGeo(table) {
  return {
    async pinFromLink(link) { return coordsFromMapsUrl(link); },
    async reverse(lat, lng) { return { address: `Pinned spot ${lat.toFixed(4)}, ${lng.toFixed(4)}`, locality: "Pinned Area", city: "Pin City", country: "Pinland" }; },
    async search(q) {
      const hit = table[String(q).toLowerCase()];
      return hit ? { lat: hit.lat, lng: hit.lng, address: q, viewport: null } : null;
    },
    async locate({ building, locality, city }) {
      for (const key of [[building, locality, city], [locality, city]]) {
        const k = key.filter(Boolean).join(", ").toLowerCase();
        if (table[k]) return { address: k, place_id: null, ...table[k] };
      }
      return null;
    }
  };
}

export const ENV = {
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  GOOGLE_MAPS_BROWSER_KEY: "maps",
  ADMIN_EMAILS: "admin@ps.in"
};

export function req(method, path, { token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  return new Request("https://ps.in/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
