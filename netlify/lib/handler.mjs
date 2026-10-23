// All /api/* routes. Dependencies are passed in so the logic can be tested without real services.
import {
  LIMITS, isUuid, clean, cleanPhone, buildingKey, validateProposal,
  makeViewer, canSee, accessSummary, toPublic, sanitizeMessages
} from "./core.mjs";

const placeCache = new Map();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

function bearer(req) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** deps: { store, ai, geo, env: { SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_MAPS_BROWSER_KEY, GOOGLE_MAP_ID, ADMIN_EMAILS } } */
export async function handle(req, deps) {
  const { store, ai, geo, env } = deps;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const method = req.method;

  try {
    if (path === "/config" && method === "GET") {
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.GOOGLE_MAPS_BROWSER_KEY) {
        return json({ error: "not_configured" }, 503);
      }
      return json({
        supabaseUrl: env.SUPABASE_URL,
        supabaseAnonKey: env.SUPABASE_ANON_KEY,
        mapsKey: env.GOOGLE_MAPS_BROWSER_KEY,
        mapId: env.GOOGLE_MAP_ID || "DEMO_MAP_ID"
      });
    }

    const user = await store.getUser(bearer(req));
    const admins = String(env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const isAdmin = !!(user && user.email && admins.includes(user.email.toLowerCase()));

    async function loadViewer() {
      if (!user) return { viewer: null, profile: null };
      const profile = await store.getProfile(user.id);
      return { viewer: makeViewer({ user, profile, isAdmin }), profile };
    }

    /* ---------- map feed (signed in or not) ---------- */
    if (path === "/feed" && method === "GET") {
      const { viewer } = await loadViewer();
      const posts = await store.activePosts();
      const visible = posts.filter((p) => canSee(p, viewer)).map((p) => toPublic(p, viewer));
      return json({ posts: visible, access: accessSummary(viewer), signedIn: !!viewer });
    }

    /* ---------- area search: find a place by name so the map can move there ---------- */
    if (path === "/geocode" && method === "GET") {
      const q = clean(url.searchParams.get("q"), 100);
      if (!q || q.length < 2) return json({ place: null });
      const key = q.toLowerCase();
      if (!placeCache.has(key)) {
        if (placeCache.size > 500) placeCache.clear();
        placeCache.set(key, await geo.search(q));
      }
      return json({ place: placeCache.get(key) });
    }

    if (!user) return json({ error: "sign_in_required" }, 401);

    /* ---------- profile ---------- */
    if (path === "/me" && method === "GET") {
      const { viewer, profile } = await loadViewer();
      return json({ email: user.email, profile, isAdmin, access: accessSummary(viewer) });
    }
    if (path === "/me" && method === "POST") {
      const body = await readJson(req);
      const name = clean(body.name, 60);
      const phone = cleanPhone(body.phone);
      if (!name || name.length < 2) return json({ error: "Please enter your name." }, 400);
      if (!phone) return json({ error: "Please enter a valid mobile number." }, 400);
      const profile = await store.upsertProfile({ id: user.id, email: user.email, name, phone });
      return json({ profile });
    }

    const profile = await store.getProfile(user.id);
    const needsProfile = !profile || !profile.name || !profile.phone;

    /* ---------- AI chat ---------- */
    if (path === "/chat" && method === "POST") {
      if (needsProfile) return json({ error: "profile_required" }, 400);
      const body = await readJson(req);
      const messages = sanitizeMessages(body.messages);
      if (!messages.length || messages[messages.length - 1].role !== "user") {
        return json({ error: "Please type a message." }, 400);
      }
      const calls = await store.bumpAiUsage(user.id);
      if (calls > LIMITS.aiCallsPerDay) {
        return json({ error: "You've reached today's limit for the posting assistant. Please try again tomorrow." }, 429);
      }

      const result = await ai.converse(messages);
      if (!result.proposal) {
        return json({
          type: "message",
          text: result.text || "Sorry, I didn't catch that. Please describe it in one message: who you are (landlord, broker, buyer or tenant), the property, the price, and the building, area and city."
        });
      }

      const v = validateProposal(result.proposal);
      if (!v.ok) return json({ type: "message", text: v.ask });

      const place = await geo.locate(v.post);
      if (!place) {
        const where = [v.post.building, v.post.locality, v.post.city].filter(Boolean).join(", ");
        return json({
          type: "message",
          text: `I couldn't find "${where}" on the map. Could you check the spelling, or add the sector number or a nearby landmark?`
        });
      }

      const draft = {
        ...v.post,
        ...place,
        building_key: buildingKey(v.post.building, v.post.city),
        contact_name: profile.name,
        contact_phone: profile.phone
      };
      const id = await store.createDraft(user.id, draft);
      return json({ type: "draft", text: result.text || "", draft: { id, ...draft, building_key: undefined, place_id: undefined } });
    }

    /* ---------- confirm a draft ---------- */
    if (path === "/posts" && method === "POST") {
      if (needsProfile) return json({ error: "profile_required" }, 400);
      const body = await readJson(req);
      if (!isUuid(body.draftId)) return json({ error: "That draft has expired. Please describe the post again." }, 404);
      const draft = await store.getDraft(body.draftId, user.id);
      if (!draft) return json({ error: "That draft has expired. Please describe the post again." }, 404);

      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      if ((await store.countPostsSince(user.id, since)) >= LIMITS.postsPerDay) {
        return json({ error: `You can post up to ${LIMITS.postsPerDay} times a day.` }, 429);
      }

      // Photos must be in this user's folder of our own storage bucket.
      const prefix = `${env.SUPABASE_URL}/storage/v1/object/public/photos/${user.id}/`;
      const photos = (Array.isArray(body.photos) ? body.photos : [])
        .filter((u) => typeof u === "string" && u.startsWith(prefix) && !u.includes("..") && u.length < 400)
        .slice(0, LIMITS.maxPhotos);

      const { notes, ...fields } = draft;
      const post = await store.createPost({
        ...fields,
        photos: draft.kind === "listing" ? photos : [],
        user_id: user.id,
        contact_name: profile.name,
        contact_phone: profile.phone,
        status: "active"
      });
      await store.deleteDraft(body.draftId);
      if (draft.poster_type === "broker" && draft.rera_number && profile.rera_number !== draft.rera_number) {
        await store.upsertProfile({ id: user.id, rera_number: draft.rera_number });
      }
      const { viewer } = await loadViewer();
      return json({ post: toPublic(post, viewer) });
    }

    /* ---------- remove a post ---------- */
    const del = path.match(/^\/posts\/([^/]+)$/);
    if (del && method === "DELETE") {
      if (!isUuid(del[1])) return json({ error: "Not found" }, 404);
      const post = await store.getPost(del[1]);
      if (!post || post.status !== "active") return json({ error: "Not found" }, 404);
      if (post.user_id !== user.id && !isAdmin) return json({ error: "You can only remove your own posts." }, 403);
      await store.setPostStatus(post.id, "removed");
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong on our side. Please try again." }, 500);
  }
}
