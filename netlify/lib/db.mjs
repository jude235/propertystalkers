// Supabase access using the server-only service key. The browser never gets this key.
import { createClient } from "@supabase/supabase-js";

/** The fields the map and the list need. No descriptions, contact details or unit numbers. */
export const LEAN = "id,user_id,kind,poster_type,deal,property_type,bedrooms,price,currency,building,locality,city,country,lat,lng,photos,room_type,suits,guests,interests,size_sqft,unit_key,status,created_at,first_price,price_changed_at,configs,building_key,amenities,company,possession,rera_number";

/** Signed-in checks remembered per server copy: token -> { user, until }. */
const userCache = new Map();
const USER_CACHE_MS = 60_000;
/** When a sign-in token runs out (ms), read from the token itself; null if it can't be read. */
export function tokenExpiry(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return Number.isFinite(json.exp) ? json.exp * 1000 : null;
  } catch (e) { return null; }
}

export function makeStore({ url, serviceKey }) {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // Map filters: drop empty values so the database never sees nulls where it expects lists.
  const tidyF = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));
  const must = ({ data, error }) => {
    if (error) throw new Error(`Database: ${error.message}`);
    return data;
  };

  /** where: { col: value | null | { in, lt, lte, gt, gte, not } } */
  const filter = (q, where = {}) => {
    for (const [k, v] of Object.entries(where)) {
      if (v === null) q = q.is(k, null);
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        if ("in" in v) q = q.in(k, v.in.length ? v.in : ["00000000-0000-0000-0000-000000000000"]);
        if ("lt" in v) q = q.lt(k, v.lt);
        if ("lte" in v) q = q.lte(k, v.lte);
        if ("gt" in v) q = q.gt(k, v.gt);
        if ("gte" in v) q = q.gte(k, v.gte);
        if ("not" in v) q = v.not === null ? q.not(k, "is", null) : q.neq(k, v.not);
      } else q = q.eq(k, v);
    }
    return q;
  };

  return {
    /* Generic table access used by the newer features. */
    async rows(table, where = {}, { order, asc = false, limit } = {}) {
      let q = filter(sb.from(table).select("*"), where);
      if (order) q = q.order(order, { ascending: asc });
      if (limit) q = q.limit(limit);
      return must(await q);
    },
    async insert(table, rows) {
      if (Array.isArray(rows) && !rows.length) return [];
      return must(await sb.from(table).insert(rows).select());
    },
    async update(table, where, patch) {
      return must(await filter(sb.from(table).update(patch), where).select());
    },
    async remove(table, where) {
      must(await filter(sb.from(table).delete(), where));
    },
    async getUser(token) {
      if (!token) return null;
      // A token checked in the last minute is trusted again without another trip to the auth server
      // (every tap on a listing needs it). Never past the token's own expiry.
      const now = Date.now();
      const hit = userCache.get(token);
      if (hit && hit.until > now) return hit.user;
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data || !data.user) { userCache.delete(token); return null; }
      const user = { id: data.user.id, email: data.user.email || null, phone: data.user.phone || null };
      const exp = tokenExpiry(token);
      const until = Math.min(now + USER_CACHE_MS, exp ? exp - 5000 : now + USER_CACHE_MS);
      if (until > now) {
        if (userCache.size >= 500) userCache.delete(userCache.keys().next().value);
        userCache.set(token, { user, until });
      }
      return user;
    },
    async getProfile(id) {
      return must(await sb.from("profiles").select("*").eq("id", id).maybeSingle());
    },
    async upsertProfile(profile) {
      return must(await sb.from("profiles").upsert(profile).select().single());
    },
    async activeByUnitKey(key) {
      return must(await sb.from("posts").select("*").eq("unit_key", key).eq("status", "active"));
    },
    async nextLead(key) {
      return must(await sb.rpc("next_lead", { k: key }));
    },
    async logLead(lead) {
      const { error } = await sb.from("leads").insert(lead);
      if (error) console.error("lead log failed", error.message); // never block a caller over the log
    },
    async avatarsFor(userIds) {
      if (!userIds.length) return {};
      const { data, error } = await sb.from("profiles").select("id, avatar_url").in("id", userIds).not("avatar_url", "is", null);
      if (error) return {}; // pictures are optional; never break the map over them
      return Object.fromEntries(data.map((r) => [r.id, r.avatar_url]));
    },
    /* ----- fast map: only what's in view ----- */
    async mapPins(f) {
      return must(await sb.rpc("map_pins", { f: tidyF(f) }).select(LEAN));
    },
    async mapClusters(f) {
      return must(await sb.rpc("map_clusters", { f: tidyF(f) }));
    },
    async mapDots(f) {
      return must(await sb.rpc("map_dots", { f: tidyF(f) }));
    },
    async postsByIds(ids) {
      if (!ids.length) return [];
      return must(await sb.from("posts").select(LEAN).in("id", ids.slice(0, 200)).eq("status", "active"));
    },
    async searchPosts(q, kind, limit = 20) {
      const s = String(q || "").replace(/[%,()*\\.:"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
      if (s.length < 2) return [];
      return must(await sb.from("posts").select(LEAN).eq("status", "active").eq("kind", kind)
        .or(`building.ilike.%${s}%,locality.ilike.%${s}%,city.ilike.%${s}%,company.ilike.%${s}%`)
        .order("created_at", { ascending: false }).limit(limit));
    },
    async sitemapRows() {
      return must(await sb.from("posts").select("id,kind,status,user_id,unit_key,price,lat,created_at,price_changed_at,confirmed_at")
        .eq("status", "active").eq("kind", "listing").order("created_at", { ascending: false }).limit(50000));
    },
    async activePosts() {
      return must(await sb.from("posts").select("*").eq("status", "active")
        .order("created_at", { ascending: false }).limit(5000));
    },
    async postsByUser(userId) {
      return must(await sb.from("posts").select("*").eq("user_id", userId));
    },
    async getPost(id) {
      return must(await sb.from("posts").select("*").eq("id", id).maybeSingle());
    },
    async createPost(post) {
      return must(await sb.from("posts").insert(post).select().single());
    },
    async createPosts(posts) {
      return must(await sb.from("posts").insert(posts).select("id"));
    },
    async existingBuildingKeys(keys) {
      if (!keys.length) return [];
      return must(await sb.from("posts").select("building_key").eq("status", "active").in("building_key", keys)).map((r) => r.building_key);
    },
    async updatePost(id, patch) {
      return must(await sb.from("posts").update(patch).eq("id", id).select().single());
    },
    async setPostStatus(id, status) {
      must(await sb.from("posts").update({ status }).eq("id", id));
    },
    async countPostsSince(userId, sinceIso) {
      const { count, error } = await sb.from("posts").select("id", { count: "exact", head: true })
        .eq("user_id", userId).gte("created_at", sinceIso);
      if (error) throw new Error(`Database: ${error.message}`);
      return count || 0;
    },
    async createDraft(userId, data) {
      return must(await sb.from("drafts").insert({ user_id: userId, data }).select("id").single()).id;
    },
    async updateDraft(id, userId, data) {
      must(await sb.from("drafts").update({ data }).eq("id", id).eq("user_id", userId));
    },
    async getDraft(id, userId) {
      const row = must(await sb.from("drafts").select("data").eq("id", id).eq("user_id", userId).maybeSingle());
      return row ? row.data : null;
    },
    async deleteDraft(id) {
      must(await sb.from("drafts").delete().eq("id", id));
    },
    async bumpAiUsage(userId) {
      return must(await sb.rpc("bump_ai_usage", { uid: userId }));
    }
  };
}
