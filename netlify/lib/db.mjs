// Supabase access using the server-only service key. The browser never gets this key.
import { createClient } from "@supabase/supabase-js";

export function makeStore({ url, serviceKey }) {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = ({ data, error }) => {
    if (error) throw new Error(`Database: ${error.message}`);
    return data;
  };

  return {
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
