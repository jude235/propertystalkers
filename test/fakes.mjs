// In-memory stand-ins for Supabase, the AI and Google, used by the tests.
import { randomUUID } from "node:crypto";

export function memoryStore() {
  const users = new Map();     // token -> { id, email }
  const profiles = new Map();
  const posts = [];
  const drafts = new Map();
  const usage = new Map();
  return {
    _users: users, _posts: posts, _profiles: profiles,
    addUser(email) { const u = { id: randomUUID(), email }; users.set("tok-" + email, u); return { ...u, token: "tok-" + email }; },
    async getUser(t) { return users.get(t) || null; },
    async getProfile(id) { return profiles.get(id) || null; },
    async upsertProfile(p) { const v = { ...(profiles.get(p.id) || {}), ...p }; profiles.set(p.id, v); return v; },
    async activePosts() { return posts.filter((p) => p.status === "active"); },
    async postsByUser(uid) { return posts.filter((p) => p.user_id === uid); },
    async getPost(id) { return posts.find((p) => p.id === id) || null; },
    async createPost(p) { const v = { id: randomUUID(), created_at: new Date().toISOString(), ...p }; posts.push(v); return v; },
    async setPostStatus(id, status) { const p = posts.find((x) => x.id === id); if (p) p.status = status; },
    async countPostsSince(uid, since) { return posts.filter((p) => p.user_id === uid && p.created_at >= since).length; },
    async createDraft(uid, data) { const id = randomUUID(); drafts.set(id, { uid, data }); return id; },
    async getDraft(id, uid) { const d = drafts.get(id); return d && d.uid === uid ? d.data : null; },
    async deleteDraft(id) { drafts.delete(id); },
    async bumpAiUsage(uid) { const n = (usage.get(uid) || 0) + 1; usage.set(uid, n); return n; }
  };
}

/** AI that returns whatever the test queued next. */
export function scriptedAI() {
  const queue = [];
  return {
    queue, calls: [],
    async converse(messages) { this.calls.push(messages); return queue.shift() || { text: "ok", proposal: null }; }
  };
}

/** Geocoder with a fixed lookup table. */
export function tableGeo(table) {
  return {
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
