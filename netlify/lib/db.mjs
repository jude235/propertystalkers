// Supabase access using the server-only service key. The browser never gets this key.
import { createClient } from "@supabase/supabase-js";

export function makeStore({ url, serviceKey }) {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
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
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data || !data.user) return null;
      return { id: data.user.id, email: data.user.email || null, phone: data.user.phone || null };
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
