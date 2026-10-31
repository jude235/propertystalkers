// All /api/* routes. Dependencies are passed in so the logic can be tested without real services.
import {
  LIMITS, POSTER_TYPES, isUuid, clean, cleanPhone, cleanRera, buildingKey, validateProposal,
  makeViewer, canSee, accessSummary, toPublic, sanitizeMessages, unitKey, leadPool, collapseUnits, roleOf, cleanInterests
} from "./core.mjs";
import { marketInfo, textFlags, FLAG_TEXT, PUBLIC_FLAGS } from "./market.mjs";
import { features } from "./features.mjs";
import { runAssistant } from "./assistant.mjs";
import { onListingLive, onRequestLive, onPriceChange } from "./events.mjs";
import { maybeRunJobs } from "./jobs.mjs";
import { mapRoutes } from "./mapapi.mjs";

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

/** Google sign-in client ID for propertystalkers.com (public, shown to every browser). */
export const GOOGLE_CLIENT_ID = "824308350413-bj2i9au6m3579c8u11sn2ak4lkmgcat8.apps.googleusercontent.com";

/** deps: { store, ai, geo, env: { SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_MAPS_BROWSER_KEY, GOOGLE_MAP_ID, ADMIN_EMAILS } } */
export async function handle(req, deps) {
  const { store, ai, geo, env } = deps;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const method = req.method;
  // Work that can finish after the reply (notifications, background jobs). Tests run it inline.
  const later = async (fn) => {
    const job = Promise.resolve().then(fn).catch((e) => console.error("background job failed", e));
    if (deps.defer) deps.defer(job); else await job;
  };

  try {
    if (path === "/config" && method === "GET") {
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.GOOGLE_MAPS_BROWSER_KEY) {
        return json({ error: "not_configured" }, 503);
      }
      return json({
        supabaseUrl: env.SUPABASE_URL,
        supabaseAnonKey: env.SUPABASE_ANON_KEY,
        mapsKey: env.GOOGLE_MAPS_BROWSER_KEY,
        mapId: env.GOOGLE_MAP_ID || "DEMO_MAP_ID",
        // Google sign-in: the public "client ID" (not a secret). Set GOOGLE_CLIENT_ID to change it.
        googleClientId: env.GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID
      });
    }

    const user = await store.getUser(bearer(req));
    const admins = String(env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const isAdmin = !!(user && user.email && admins.includes(user.email.toLowerCase()));

    async function loadViewer() {
      if (!user) return { viewer: null, profile: null };
      // Both at once: each trip to the database takes a while.
      const [profile, shares] = await Promise.all([
        store.getProfile(user.id),
        store.rows("posts", { user_id: user.id, kind: "listing", deal: "share", status: "active" }, { limit: 1 })
      ]);
      return { viewer: makeViewer({ user, profile, isAdmin, sharesSpace: shares.length > 0 }), profile };
    }

    /* ---------- map feed (signed in or not) ---------- */
    if (path === "/feed" && method === "GET") {
      const { viewer } = await loadViewer();
      const posts = await store.activePosts();
      const avatars = await store.avatarsFor([...new Set(posts.map((p) => p.user_id))]);
      for (const p of posts) p.contact_avatar = avatars[p.user_id] || null;
      const info = marketInfo(posts);
      const watched = viewer ? new Set((await store.rows("watches", { user_id: viewer.id })).map((w) => w.post_id)) : new Set();
      const hiddenIds = viewer ? new Set((await store.rows("hidden_posts", { user_id: viewer.id }, { limit: 2000 })).map((h) => h.post_id)) : new Set();
      const visible = collapseUnits(posts, viewer).filter((p) => canSee(p, viewer)).map((p) => {
        const out = toPublic(p, viewer);
        const i = info.get(p.id) || {};
        const insider = viewer && (viewer.id === p.user_id || viewer.isAdmin);
        const flags = [...(Array.isArray(p.flags) ? p.flags : []), ...(i.below_pct >= 40 ? ["far_below_market"] : [])];
        out.below_market_pct = i.below_pct >= 5 ? i.below_pct : 0;
        out.price_cut_pct = i.cut_pct || 0;
        out.good_deal = !!i.deal;
        out.warnings = flags.filter((f) => insider || PUBLIC_FLAGS.includes(f)).map((f) => FLAG_TEXT[f]).filter(Boolean);
        out.watched = watched.has(p.id);
        out.hidden = hiddenIds.has(p.id);
        out.cobroke = !!p.cobroke && (insider || !!(viewer && viewer.isBroker));
        out.needs_confirm = !!(insider && p.stale_notified_at);
        return out;
      });
      await later(() => maybeRunJobs(deps));
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

    /* ---------- the fast map, listing details, search, shortlist (see mapapi.mjs) ---------- */
    const m = await mapRoutes({ path, method, url, req, deps, json, readJson, loadViewer, user, later, maybeRunJobs });
    if (m) return m;

    /* ---------- contact for a listing: hands out leads in turn (signed in or not) ---------- */
    const contactM = path.match(/^\/posts\/([^/]+)\/contact$/);
    if (contactM && method === "POST") {
      if (!isUuid(contactM[1])) return json({ error: "Not found" }, 404);
      const post = await store.getPost(contactM[1]);
      const { viewer } = await loadViewer();
      if (!post || !canSee(post, viewer)) return json({ error: "That post is no longer available." }, 404);
      let to = post;
      if (post.kind === "listing" && post.unit_key) {
        const pool = leadPool(await store.activeByUnitKey(post.unit_key));
        if (pool.length > 1) {
          const n = await store.nextLead(post.unit_key);
          to = pool[(n - 1) % pool.length];
        } else if (pool.length === 1) to = pool[0];
        await store.logLead({ unit_key: post.unit_key, post_id: to.id, viewer_id: user ? user.id : null });
      }
      const pic = (await store.avatarsFor([to.user_id]))[to.user_id] || null;
      return json({ contact: { post_id: to.id, name: to.contact_name, phone: to.contact_phone, avatar: pic } });
    }

    if (path.startsWith("/repair/")) {
      const r = await features({ path, method, req, url, user: null, deps, json, readJson, loadViewer });
      if (r) return r;
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
      // How many listings this person shortlisted and hid (shown in My profile and the list).
      const counts = {
        shortlist: (await store.rows("watches", { user_id: user.id }, { limit: 1000 })).length,
        hidden: (await store.rows("hidden_posts", { user_id: user.id }, { limit: 2000 })).length,
        requests: (await store.rows("posts", { user_id: user.id, kind: "request", status: "active" }, { limit: 50 })).length
      };
      return json({ email: user.email || null, phone: user.phone || null, profile, isAdmin, access: accessSummary(viewer), counts });
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
      if (typeof body.notify_email === "boolean") update.notify_email = body.notify_email;
      if (Array.isArray(body.interests)) update.interests = cleanInterests(body.interests);
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
      const role = roleOf(String(body.role || "").toLowerCase());
      if (!role) return json({ error: "Please choose how you'll use Property Stalkers." }, 400);
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

    /** The same unit may be listed at most 3 times for sale (and 3 for rent), once per person. */
    async function unitProblem(key, deal, exceptId = null) {
      if (!key) return null;
      const others = (await store.activeByUnitKey(key)).filter((p) => p.id !== exceptId);
      const what = { rent: "for rent", share: "for co-living", stay: "as a holiday home" }[deal] || "for sale";
      if (others.some((p) => p.user_id === user.id)) return `You've already listed this unit ${what}. You can edit that post instead.`;
      if (others.length >= LIMITS.listingsPerUnit) return `This unit is already listed ${what} ${LIMITS.listingsPerUnit} times, which is the most allowed. It can't be listed again unless one of those is removed.`;
      return null;
    }

    /** Validate, place on the map and save a draft for the user to confirm. */
    async function makeDraft(proposal) {
      const v = validateProposal(proposal);
      if (!v.ok) return { message: v.ask };
      const { maps_link, ...postFields } = v.post;
      v.post = postFields;
      let place = await geo.locate(v.post);
      if (maps_link) {
        // Pin fixer: a Google Maps link gives the exact spot.
        const pin = await geo.pinFromLink(maps_link);
        if (pin) place = { address: place ? place.address : null, place_id: null, ...(place || {}), lat: pin.lat, lng: pin.lng, precision: "building" };
        else if (!place) return { message: "I couldn't read a location from that map link. Please open the place in Google Maps, tap Share, and paste that link." };
      }
      if (!place) {
        // Not found: keep the draft and let the person drop the pin themselves.
        place = { lat: null, lng: null, precision: "building", address: null, place_id: null, needs_pin: true };
      }
      const problem = await unitProblem(unitKey(v.post), v.post.deal);
      if (problem) return { message: problem };
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

    /* ---------- set the pin on a draft (dropped on the map or from current location) ---------- */
    const pinM = path.match(/^\/drafts\/([^/]+)\/pin$/);
    if (pinM && method === "POST") {
      if (!isUuid(pinM[1])) return json({ error: "That draft has expired." }, 404);
      const draft = await store.getDraft(pinM[1], user.id);
      if (!draft) return json({ error: "That draft has expired. Please describe the post again." }, 404);
      const b = await readJson(req);
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (!lat && !lng)) {
        return json({ error: "That spot isn't valid. Please try again." }, 400);
      }
      const where = await geo.reverse(lat, lng).catch(() => null);
      const next = { ...draft, lat, lng, precision: "building", place_id: null, needs_pin: false,
        address: (where && where.address) || draft.address || null,
        locality: draft.locality || (where && where.locality) || null,
        city: draft.city || (where && where.city) || null,
        country: draft.country || (where && where.country) || null };
      await store.updateDraft(pinM[1], user.id, next);
      return json({ draft: { id: pinM[1], ...next, building_key: undefined, place_id: undefined } });
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
      const messages = sanitizeMessages(body.messages).map((m) => {
        // Photos-to-listing: the AI can look at photos the user uploaded to their own folder.
        const pics = m.images ? ownPhotos(m.images, user.id) : [];
        if (!pics.length) return { role: m.role, content: m.content };
        return { role: m.role, content: [...pics.map((url) => ({ type: "image", source: { type: "url", url } })), { type: "text", text: m.content }] };
      });
      if (!messages.length || messages[messages.length - 1].role !== "user") {
        return json({ error: "Please type a message." }, 400);
      }
      const calls = await store.bumpAiUsage(user.id);
      if (calls > LIMITS.aiCallsPerDay) {
        return json({ error: "You've reached today's limit for the posting assistant. Please try again tomorrow." }, 429);
      }

      const role = roleOf(profile.role);
      const result = await ai.converse(messages, { role });
      if (!result.proposal) {
        return json({
          type: "message",
          text: result.text || "Sorry, I didn't catch that. Please describe it in one message: the property, the price, and the building, area and city."
        });
      }

      // The user's chosen role decides who they post as.
      // Buyer / Tenant posts as a buyer when buying and as a tenant when renting or looking for co-living.
      const poster_type = role === "seeker" ? (result.proposal.deal === "sale" ? "buyer" : "tenant") : role;
      const proposal = { ...result.proposal, poster_type };
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

      const { notes, needs_pin, ...fields } = draft;
      if (needs_pin || fields.lat == null) return json({ error: "Please set the pin on the map first." }, 400);
      if (draft.kind === "listing" && draft.deal === "share" && body.share_permission !== true) {
        return json({ error: "Please confirm you have permission to share this space (from the owner or landlord)." }, 400);
      }
      const unit_key = draft.kind === "listing" ? unitKey(draft) : null;
      const problem = await unitProblem(unit_key, draft.deal);
      if (problem) return json({ error: problem }, 409);
      const post = await store.createPost({
        ...fields,
        unit_key,
        first_price: fields.price || null,
        confirmed_at: new Date().toISOString(),
        flags: textFlags({ ...fields, kind: draft.kind }),
        cobroke: draft.poster_type === "broker" && !!body.cobroke,
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
      await later(() => (post.kind === "listing" ? onListingLive(deps, post) : onRequestLive(deps, post)));
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
        possession: pick("possession"), configs: pick("configs"), description: pick("description"),
        unit_number: pick("unit_number"), size_sqft: pick("size_sqft"), maps_link: b.maps_link,
        room_type: pick("room_type"), room: pick("room"), suits: pick("suits"), bills_included: pick("bills_included"), move_in: pick("move_in"), amenities: pick("amenities"),
        interests: pick("interests"), guests: pick("guests"), min_nights: pick("min_nights"),
        share_offer: post.kind === "listing"
      });
      if (!v.ok) return json({ error: v.ask }, 400);
      const { notes, kind, poster_type, maps_link, ...fields } = v.post;
      let pin = null;
      if (b.maps_link) {
        pin = maps_link ? await geo.pinFromLink(maps_link) : null;
        if (!pin) return json({ error: "That doesn't look like a Google Maps link with a location. In Google Maps, tap Share and paste the link." }, 400);
      }
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
      if (pin) Object.assign(fields, { lat: pin.lat, lng: pin.lng, precision: "building" });
      // "Move the pin": a spot picked on the map.
      if (b.pin && typeof b.pin === "object") {
        const lat = Number(b.pin.lat), lng = Number(b.pin.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: "That spot isn't valid." }, 400);
        const where = await geo.reverse(lat, lng).catch(() => null);
        Object.assign(fields, { lat, lng, precision: "building", place_id: null }, where && where.address ? { address: where.address } : {});
      }
      if (post.kind === "listing") {
        fields.unit_key = unitKey(fields);
        if (fields.unit_key !== post.unit_key) {
          const problem = await unitProblem(fields.unit_key, fields.deal, post.id);
          if (problem) return json({ error: problem }, 409);
        }
      }
      if (post.kind === "listing" && Array.isArray(b.photos)) {
        fields.photos = ownPhotos(b.photos, post.user_id);
      }
      if (post.poster_type === "broker" && typeof b.cobroke === "boolean") fields.cobroke = b.cobroke;
      fields.flags = textFlags({ ...post, ...fields, kind: post.kind, poster_type: post.poster_type });
      const priceChanged = (fields.price || null) !== (post.price || null);
      if (priceChanged) {
        fields.price_changed_at = new Date().toISOString();
        if (!post.first_price) fields.first_price = post.price || fields.price || null;
      }
      const before = { ...post };
      const updated = await store.updatePost(post.id, fields);
      if (updated.kind === "listing") {
        await later(() => (priceChanged ? onPriceChange(deps, updated, before.price) : onListingLive(deps, updated, { previous: before })));
      }
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

    /* ---------- Ask Stalker ---------- */
    if (path === "/assistant" && method === "POST") {
      if (needsProfile) return json({ error: "profile_required" }, 400);
      const body = await readJson(req);
      const messages = sanitizeMessages(body.messages);
      if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "Please type a message." }, 400);
      if ((await store.bumpAiUsage(user.id)) > LIMITS.aiCallsPerDay) {
        return json({ error: "You've reached today's limit for the assistant. Please try again tomorrow." }, 429);
      }
      const { viewer } = await loadViewer();
      const context = body.context && isUuid(body.context.post_id) ? { post_id: body.context.post_id } : {};
      const r = await runAssistant({ deps, user, profile, viewer, messages, context,
        makeRequestDraft: (proposal) => makeDraft(proposal) });
      return json(r);
    }

    const extra = await features({ path, method, req, url, user, profile, isAdmin, deps, json, readJson, loadViewer, needsProfile });
    if (extra) return extra;

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong on our side. Please try again." }, 500);
  }
}
