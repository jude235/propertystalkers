// All /api/* routes. Dependencies are passed in so the logic can be tested without real services.
import {
  LIMITS, POSTER_TYPES, isUuid, clean, cleanPhone, cleanRera, buildingKey, validateProposal,
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
      const avatars = await store.avatarsFor([...new Set(posts.map((p) => p.user_id))]);
      for (const p of posts) p.contact_avatar = avatars[p.user_id] || null;
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

    /** Keep only photos in the owner's folder of our bucket (direct or via the /sb proxy), stored in canonical form. */
    function ownPhotos(list, ownerId) {
      const real = `${env.SUPABASE_URL}/storage/v1/object/public/photos/${ownerId}/`;
      const proxied = `${url.origin}/sb/storage/v1/object/public/photos/${ownerId}/`;
      return (Array.isArray(list) ? list : [])
        .filter((u) => typeof u === "string" && !u.includes("..") && u.length < 400)
        .map((u) => (u.startsWith(proxied) ? real + u.slice(proxied.length) : u))
        .filter((u) => u.startsWith(real))
        .slice(0, LIMITS.maxPhotos);
    }


    /* ---------- profile ---------- */
    if (path === "/me" && method === "GET") {
      const { viewer, profile } = await loadViewer();
      return json({ email: user.email || null, phone: user.phone || null, profile, isAdmin, access: accessSummary(viewer) });
    }
    if (path === "/me" && method === "POST") {
      const body = await readJson(req);
      const existing = await store.getProfile(user.id);
      const name = clean(body.name, 60);
      const phone = cleanPhone(body.phone);
      const email = String(body.email || user.email || "").trim().toLowerCase().slice(0, 120);
      if (!name || name.length < 2) return json({ error: "Please enter your name." }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400);
      if (!phone) return json({ error: "Please enter a valid mobile number with country code." }, 400);
      const update = { id: user.id, email, name, phone };
      if (body.rera !== undefined) {
        const raw = String(body.rera || "").trim();
        const rera = raw ? cleanRera(raw) : null;
        if (raw && !rera) return json({ error: "That licence / RERA number doesn't look right. Please check it, or leave it empty." }, 400);
        if (!rera && existing && existing.role === "broker") {
          return json({ error: "Brokers need a licence / RERA number. Add it, or switch role first." }, 400);
        }
        update.rera_number = rera;
      }
      if (body.avatar !== undefined) {
        // A profile picture must be in the user's own folder of our photo bucket; empty removes it.
        const pic = body.avatar ? ownPhotos([body.avatar], user.id)[0] : null;
        if (body.avatar && !pic) return json({ error: "That profile picture couldn't be used. Please upload it again." }, 400);
        update.avatar_url = pic;
      }
      const profile = await store.upsertProfile(update);
      return json({ profile });
    }

    /* ---------- choose / switch role ---------- */
    if (path === "/me/role" && method === "POST") {
      const body = await readJson(req);
      const role = String(body.role || "").toLowerCase();
      if (!POSTER_TYPES.includes(role)) return json({ error: "Please choose how you'll use Property Stalkers." }, 400);
      const update = { id: user.id, role };
      if (role === "broker") {
        const licence = cleanRera(body.licence);
        if (!licence) return json({ error: "Please enter your broker licence / RERA number." }, 400);
        update.rera_number = licence;
      }
      if (role === "developer") {
        const company = clean(body.company, 80);
        if (!company) return json({ error: "Please enter your company name." }, 400);
        update.company = company;
      }
      const profile = await store.upsertProfile(update);
      const viewer = makeViewer({ user, profile, isAdmin });
      return json({ profile, access: accessSummary(viewer) });
    }

    const profile = await store.getProfile(user.id);
    const needsProfile = !profile || !profile.name || !profile.phone || !profile.email;

    /** Validate, place on the map and save a draft for the user to confirm. */
    async function makeDraft(proposal) {
      const v = validateProposal(proposal);
      if (!v.ok) return { message: v.ask };
      const place = await geo.locate(v.post);
      if (!place) {
        const where = [v.post.building, v.post.locality, v.post.city].filter(Boolean).join(", ");
        return { message: `I couldn't find "${where}" on the map. Could you check the spelling, or add the area name or a nearby landmark?` };
      }
      const draft = {
        ...v.post,
        ...place,
        building_key: buildingKey(v.post.building, v.post.city),
        contact_name: profile.name,
        contact_phone: profile.phone
      };
      const id = await store.createDraft(user.id, draft);
      return { draft: { id, ...draft, building_key: undefined, place_id: undefined } };
    }

    /* ---------- developer project form (no AI needed) ---------- */
    if (path === "/draft" && method === "POST") {
      if (needsProfile) return json({ error: "profile_required" }, 400);
      if ((await store.bumpAiUsage(user.id)) > LIMITS.aiCallsPerDay) {
        return json({ error: "You've reached today's limit. Please try again tomorrow." }, 429);
      }
      const b = await readJson(req);
      const r = await makeDraft({
        poster_type: "developer", deal: b.deal === "rent" ? "rent" : "sale",
        company: b.company, building: b.project, locality: b.area, city: b.city, country: b.country,
        rera_number: b.rera, property_type: b.property_type, configs: b.configs, bedrooms: b.bedrooms,
        price: b.price, currency: b.currency, possession: b.possession, description: b.description
      });
      if (r.message) return json({ error: r.message }, 400);
      return json({ draft: r.draft });
    }

    /* ---------- AI chat ---------- */
    if (path === "/chat" && method === "POST") {
      if (needsProfile) return json({ error: "profile_required" }, 400);
      if (!profile.role) return json({ error: "role_required" }, 400);
      const body = await readJson(req);
      const messages = sanitizeMessages(body.messages);
      if (!messages.length || messages[messages.length - 1].role !== "user") {
        return json({ error: "Please type a message." }, 400);
      }
      const calls = await store.bumpAiUsage(user.id);
      if (calls > LIMITS.aiCallsPerDay) {
        return json({ error: "You've reached today's limit for the posting assistant. Please try again tomorrow." }, 429);
      }

      const result = await ai.converse(messages, { role: profile.role });
      if (!result.proposal) {
        return json({
          type: "message",
          text: result.text || "Sorry, I didn't catch that. Please describe it in one message: the property, the price, and the building, area and city."
        });
      }

      // The user's chosen role decides who they post as.
      const proposal = { ...result.proposal, poster_type: profile.role };
      if (profile.role === "broker" && !proposal.rera_number) proposal.rera_number = profile.rera_number;
      if (profile.role === "developer" && !proposal.company) proposal.company = profile.company;
      const r = await makeDraft(proposal);
      if (r.message) return json({ type: "message", text: r.message });
      return json({ type: "draft", text: result.text || "", draft: r.draft });
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
      const photos = ownPhotos(body.photos, user.id);

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

    /* ---------- edit your own post ---------- */
    const edit = path.match(/^\/posts\/([^/]+)$/);
    if (edit && method === "PATCH") {
      if (!isUuid(edit[1])) return json({ error: "Not found" }, 404);
      const post = await store.getPost(edit[1]);
      if (!post || post.status !== "active") return json({ error: "Not found" }, 404);
      if (post.user_id !== user.id && !isAdmin) return json({ error: "You can only edit your own posts." }, 403);
      const b = await readJson(req);
      const pick = (k) => (b[k] === undefined ? post[k] : b[k]);
      const v = validateProposal({
        poster_type: post.poster_type, deal: pick("deal"), property_type: pick("property_type"), bedrooms: pick("bedrooms"),
        price: pick("price"), currency: pick("currency"), building: pick("building"), locality: pick("locality"),
        city: pick("city"), country: pick("country"), rera_number: pick("rera_number"), company: pick("company"),
        possession: pick("possession"), configs: pick("configs"), description: pick("description")
      });
      if (!v.ok) return json({ error: v.ask }, 400);
      const { notes, kind, poster_type, ...fields } = v.post;
      // A broker who clears the licence number isn't turned into a landlord on edit; keep their old number.
      if (post.poster_type === "broker" && !fields.rera_number) fields.rera_number = post.rera_number;
      const norm = (x) => String(x || "").trim().toLowerCase();
      const moved = ["building", "locality", "city", "country"].some((k) => norm(fields[k]) !== norm(post[k]));
      if (moved) {
        const place = await geo.locate(fields);
        if (!place) {
          const where = [fields.building, fields.locality, fields.city].filter(Boolean).join(", ");
          return json({ error: `Couldn't find "${where}" on the map. Check the spelling or add the area name.` }, 400);
        }
        Object.assign(fields, place, { building_key: buildingKey(fields.building, fields.city) });
      }
      if (post.kind === "listing" && Array.isArray(b.photos)) {
        fields.photos = ownPhotos(b.photos, post.user_id);
      }
      const updated = await store.updatePost(post.id, fields);
      const { viewer } = await loadViewer();
      return json({ post: toPublic(updated, viewer) });
    }

    /* ---------- admin: import developer projects from DLD open data ---------- */
    if (path === "/admin/import-projects" && method === "POST") {
      if (!isAdmin) return json({ error: "Admins only." }, 403);
      if (needsProfile) return json({ error: "profile_required" }, 400);
      const body = await readJson(req);
      const list = (Array.isArray(body.projects) ? body.projects : []).slice(0, LIMITS.importBatch);
      const rows = list.map((p) => ({
        id: clean(String(p.id ?? ""), 20).replace(/[^0-9A-Za-z-]/g, ""),
        name: clean(p.name, 100),
        area: clean(p.area, 100),
        developer: clean(p.developer, 80),
        completion: clean(p.completion, 40),
        status: clean(p.status, 40),
        percent: Number.isFinite(+p.percent) ? Math.max(0, Math.min(100, Math.round(+p.percent))) : null,
        villas: Math.max(0, Math.min(100000, parseInt(p.villas, 10) || 0)),
        units: Math.max(0, Math.min(100000, parseInt(p.units, 10) || 0)),
        master: clean(p.master, 100)
      })).filter((r) => r.id && r.name && r.developer);
      const keys = rows.map((r) => `dld:${r.id}`);
      const existing = new Set(await store.existingBuildingKeys(keys));
      const result = { created: 0, skipped: 0, unplaced: [] };
      const fresh = [];
      for (const r of rows) {
        if (existing.has(`dld:${r.id}`)) { result.skipped++; continue; }
        existing.add(`dld:${r.id}`);
        const where = { city: "Dubai", country: "United Arab Emirates" };
        let place = await geo.locate({ building: r.name, locality: r.area, ...where });
        // Project names often match a sales office elsewhere; trust a building pin only if it's in the project's area.
        const squash = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (place && place.precision === "building" && r.area && !squash(place.address).includes(squash(r.area))) {
          place = r.area ? await geo.locate({ locality: r.area, ...where }) : null;
        }
        if (!place || !/dubai/i.test(place.address || "")) { result.unplaced.push(r.id); continue; }
        const bits = [`Off-plan project by ${r.developer}${r.master ? `, part of ${r.master}` : ""}.`];
        if (r.status) bits.push(`Status: ${r.status}${r.percent != null ? `, ${r.percent}% built` : ""}.`);
        if (r.completion) bits.push(`Expected completion ${r.completion}.`);
        bits.push("Details from Dubai Land Department records; prices on request.");
        fresh.push({
          kind: "listing", poster_type: "developer", deal: "sale",
          property_type: r.villas > r.units ? "villa" : "apartment",
          configs: [r.units ? `${r.units} units` : "", r.villas ? `${r.villas} villas` : ""].filter(Boolean).join(", ") || null,
          building: r.name, locality: r.area || null, city: "Dubai", country: "United Arab Emirates",
          company: r.developer, possession: r.completion || null, rera_number: null,
          description: bits.join(" ").slice(0, 400), price: null, currency: "AED",
          ...place, place_id: place.place_id || null, building_key: `dld:${r.id}`,
          photos: [], user_id: user.id, contact_name: "Property Stalkers enquiries",
          contact_phone: profile.phone, status: "active"
        });
      }
      if (fresh.length) await store.createPosts(fresh);
      result.created = fresh.length;
      return json(result);
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
