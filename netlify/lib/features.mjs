// Phase 1 + 2 routes: notifications, alerts, watching, enquiries and viewings, pitches, co-broking,
// tenancies with repair links, the admin flag list, and background jobs.
import { isUuid, clean, cleanPhone, canSee, leadPool } from "./core.mjs";
import { matchesCriteria, describeCriteria, listingFitsRequest } from "./market.mjs";
import { notifyMany } from "./notify.mjs";
import { postTitle } from "./events.mjs";
import { runJobs } from "./jobs.mjs";

const toInt = (v, min, max) => {
  const n = Math.round(Number(String(v ?? "").replace(/[^0-9.]/g, "")));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/** Clean a search / alert definition coming from the browser or the assistant. */
export function cleanCriteria(c = {}) {
  const out = {};
  if (["listing", "request"].includes(c.kind)) out.kind = c.kind;
  if (["sale", "rent"].includes(c.deal)) out.deal = c.deal;
  if (["home", "commercial", "land", "project"].includes(c.category)) out.category = c.category;
  if (Array.isArray(c.types)) out.types = c.types.filter((t) => typeof t === "string").slice(0, 6);
  for (const k of ["min_bedrooms", "max_bedrooms"]) { const n = toInt(c[k], 0, 20); if (n) out[k] = n; }
  for (const k of ["min_price", "max_price"]) { const n = toInt(c[k], 1, 1e11); if (n) out[k] = n; }
  for (const k of ["min_size", "max_size"]) { const n = toInt(c[k], 1, 1e8); if (n) out[k] = n; }
  if (c.currency) out.currency = String(c.currency).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || undefined;
  if (c.city) out.city = clean(c.city, 60);
  if (c.area) out.area = clean(c.area, 100);
  if (c.deals_only) out.deals_only = true;
  if (c.cobroke_only) out.cobroke_only = true;
  return out;
}

/** Who should hear about an enquiry on a listing: unit listings take turns, like calls do. */
export async function leadTarget(store, post) {
  if (!post.unit_key) return post;
  const pool = leadPool(await store.activeByUnitKey(post.unit_key));
  if (pool.length > 1) return pool[((await store.nextLead(post.unit_key)) - 1) % pool.length];
  return pool[0] || post;
}

function newToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function features(c) {
  const { path, method, user, profile, isAdmin, deps, json, readJson, loadViewer, needsProfile, url } = c;
  const { store } = deps;
  let parsed;
  const read = async () => (parsed ??= method === "GET" || method === "DELETE" ? {} : await readJson(c.req));

  /* ---------- repair requests from tenants: no sign-in, the secret link is the key ---------- */
  const rep = path.match(/^\/repair\/([a-f0-9]{36})$/);
  if (rep) {
    const [t] = await store.rows("tenancies", { repair_token: rep[1] });
    if (!t) return json({ error: "This repair link isn't valid any more. Please ask your landlord for a new one." }, 404);
    if (method === "GET") return json({ label: t.label, tenant_name: t.tenant_name || null });
    if (method === "POST") {
      const body = await read();
      const msg = clean(body.message, 800);
      if (!msg || msg.length < 5) return json({ error: "Please describe what needs fixing." }, 400);
      const since = new Date(Date.now() - 86400000).toISOString();
      const recent = await store.rows("notifications", { user_id: t.user_id, kind: "repair", ref_id: t.id, created_at: { gte: since } });
      if (recent.length >= 10) return json({ error: "Too many requests today. Please contact your landlord directly." }, 429);
      const who = clean(body.name, 60) || t.tenant_name || "Your tenant";
      const phone = cleanPhone(body.phone);
      await notifyMany(deps, [{ user_id: t.user_id, kind: "repair", ref_id: t.id,
        title: `Repair request: ${t.label}`, body: `${who}${phone ? " (+" + phone + ")" : ""}: ${msg}` }]);
      return json({ ok: true });
    }
  }

  if (!user) return null; // everything below needs sign-in (the main handler answers 401)

  /* ---------- notifications ---------- */
  if (path === "/notifications" && method === "GET") {
    const items = await store.rows("notifications", { user_id: user.id }, { order: "created_at", limit: 60 });
    const refIds = [...new Set(items.map((n) => n.ref_id).filter(Boolean))];
    const enquiries = refIds.length ? await store.rows("enquiries", { id: { in: refIds } }) : [];
    const people = new Set(enquiries.flatMap((e) => [e.from_user, e.to_user]));
    const profiles = people.size ? await store.rows("profiles", { id: { in: [...people] } }) : [];
    const pById = new Map(profiles.map((p) => [p.id, p]));
    const eById = new Map(enquiries.map((e) => [e.id, e]));
    const person = (id, show) => { const p = pById.get(id) || {}; return { name: p.name || "Member", phone: show ? p.phone || null : null, licence: p.rera_number || null }; };
    const out = items.map((n) => {
      const e = eById.get(n.ref_id);
      const enquiry = e && (e.from_user === user.id || e.to_user === user.id) ? {
        id: e.id, kind: e.kind, status: e.status, slot: e.slot, message: e.message, summary: e.summary,
        post_id: e.post_id, request_id: e.request_id, incoming: e.to_user === user.id,
        // The person who reached out shares their number. The lister's number goes back once a viewing is accepted.
        from: person(e.from_user, true),
        to: person(e.to_user, e.kind !== "viewing" || e.status === "accepted")
      } : null;
      return { id: n.id, kind: n.kind, title: n.title, body: n.body, post_id: n.post_id, ref_id: n.ref_id, created_at: n.created_at, read: !!n.read_at, enquiry };
    });
    return json({ items: out, unread: out.filter((n) => !n.read).length });
  }
  if (path === "/notifications/read" && method === "POST") {
    const body = await read();
    const where = { user_id: user.id, read_at: null };
    if (Array.isArray(body.ids) && body.ids.every(isUuid)) where.id = { in: body.ids };
    await store.update("notifications", where, { read_at: new Date().toISOString() });
    return json({ ok: true });
  }

  /* ---------- saved searches / alerts ---------- */
  if (path === "/alerts" && method === "GET") {
    return json({ alerts: await store.rows("saved_searches", { user_id: user.id }, { order: "created_at" }) });
  }
  if (path === "/alerts" && method === "POST") {
    const body = await read();
    const criteria = cleanCriteria(body.criteria || {});
    if (!criteria.city && !criteria.area) return json({ error: "Please say which city or area the alert is for." }, 400);
    const mine = await store.rows("saved_searches", { user_id: user.id });
    if (mine.length >= 20) return json({ error: "You can have up to 20 alerts. Remove one first." }, 400);
    const label = clean(body.label, 80) || describeCriteria(criteria);
    const [row] = await store.insert("saved_searches", { user_id: user.id, label, criteria });
    const all = await store.activePosts();
    const { viewer } = await loadViewer();
    const now = all.filter((p) => canSee(p, viewer) && matchesCriteria(p, criteria)).length;
    return json({ alert: row, matching_now: now });
  }
  const alertDel = path.match(/^\/alerts\/([^/]+)$/);
  if (alertDel && method === "DELETE") {
    if (!isUuid(alertDel[1])) return json({ error: "Not found" }, 404);
    await store.remove("saved_searches", { id: alertDel[1], user_id: user.id });
    return json({ ok: true });
  }

  /* ---------- watch a listing (price-drop alerts) ---------- */
  const watch = path.match(/^\/posts\/([^/]+)\/watch$/);
  if (watch) {
    if (!isUuid(watch[1])) return json({ error: "Not found" }, 404);
    if (method === "POST") {
      const post = await store.getPost(watch[1]);
      if (!post || post.status !== "active" || post.kind !== "listing") return json({ error: "Not found" }, 404);
      const has = await store.rows("watches", { user_id: user.id, post_id: post.id });
      if (!has.length) await store.insert("watches", { user_id: user.id, post_id: post.id });
      return json({ watching: true });
    }
    if (method === "DELETE") {
      await store.remove("watches", { user_id: user.id, post_id: watch[1] });
      return json({ watching: false });
    }
  }

  /* ---------- "still available" ---------- */
  const confirm = path.match(/^\/posts\/([^/]+)\/confirm$/);
  if (confirm && method === "POST") {
    if (!isUuid(confirm[1])) return json({ error: "Not found" }, 404);
    const post = await store.getPost(confirm[1]);
    if (!post || post.status === "removed") return json({ error: "Not found" }, 404);
    if (post.user_id !== user.id && !isAdmin) return json({ error: "Only the person who posted it can confirm it." }, 403);
    if (post.status === "expired" && post.unit_key) {
      const others = (await store.activeByUnitKey(post.unit_key)).filter((p) => p.id !== post.id);
      if (others.length >= 3) return json({ error: "This unit is now listed 3 times by others, so it can't go back on the map." }, 409);
    }
    await store.update("posts", { id: post.id }, { status: "active", confirmed_at: new Date().toISOString(), stale_notified_at: null });
    return json({ ok: true });
  }

  /* ---------- questions, viewing requests and co-broke requests on a listing ---------- */
  const enq = path.match(/^\/posts\/([^/]+)\/enquire$/);
  if (enq && method === "POST") {
    const body = await read();
    if (!isUuid(enq[1])) return json({ error: "Not found" }, 404);
    if (needsProfile) return json({ error: "profile_required" }, 400);
    const post = await store.getPost(enq[1]);
    const { viewer } = await loadViewer();
    if (!post || post.kind !== "listing" || !canSee(post, viewer)) return json({ error: "That listing is no longer available." }, 404);
    const kind = ["question", "viewing", "cobroke"].includes(body.kind) ? body.kind : "question";
    if (kind === "cobroke") {
      if (!(viewer && viewer.isBroker)) return json({ error: "Only licensed brokers can ask to co-broke." }, 403);
      if (!post.cobroke) return json({ error: "This listing isn't open to co-broking." }, 400);
    }
    let slot = null;
    if (kind === "viewing") {
      const t = Date.parse(body.slot);
      if (!Number.isFinite(t) || t < Date.now() + 30 * 60000 || t > Date.now() + 60 * 86400000) {
        return json({ error: "Please pick a viewing time between 30 minutes and 60 days from now." }, 400);
      }
      slot = new Date(t).toISOString();
    }
    const since = new Date(Date.now() - 86400000).toISOString();
    if ((await store.rows("enquiries", { from_user: user.id, created_at: { gte: since } })).length >= 30) {
      return json({ error: "You've sent a lot of enquiries today. Please try again tomorrow." }, 429);
    }
    const to = await leadTarget(store, post);
    if (to.user_id === user.id) return json({ error: "That's your own listing." }, 400);
    const message = clean(body.message, 800);
    const summary = clean(body.summary, 600);
    const [e] = await store.insert("enquiries", { kind, post_id: to.id, from_user: user.id, to_user: to.user_id, message, summary, slot });
    const who = profile.name || "Someone";
    const title = kind === "viewing"
      ? `Viewing request: ${postTitle(to)}`
      : kind === "cobroke" ? `Co-broke request from ${who}: ${postTitle(to)}` : `New enquiry: ${postTitle(to)}`;
    const when = slot ? new Date(slot).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai", timeZoneName: "short" }) : "";
    await notifyMany(deps, [{ user_id: to.user_id, kind: `enquiry_${kind}`, post_id: to.id, ref_id: e.id, title,
      body: [kind === "viewing" ? `${who} would like to view it on ${when}.` : `${who} sent an enquiry.`, summary, message].filter(Boolean).join(" ") }]);
    return json({ ok: true, enquiry_id: e.id });
  }

  /* ---------- pitch a listing to a buyer's / tenant's request ---------- */
  const pitch = path.match(/^\/requests\/([^/]+)\/pitch$/);
  if (pitch && method === "POST") {
    const body = await read();
    if (!isUuid(pitch[1]) || !isUuid(body.post_id)) return json({ error: "Not found" }, 404);
    if (needsProfile) return json({ error: "profile_required" }, 400);
    const req = await store.getPost(pitch[1]);
    const listing = await store.getPost(body.post_id);
    if (!req || req.kind !== "request" || req.status !== "active") return json({ error: "That request is no longer active." }, 404);
    if (!listing || listing.user_id !== user.id || listing.status !== "active") return json({ error: "You can only pitch your own active listing." }, 403);
    const { viewer } = await loadViewer();
    // Brokers can see requests and pitch anything; owners can pitch only a listing the matcher found for them.
    if (!(viewer && (viewer.isBroker || viewer.isAdmin)) && !listingFitsRequest(listing, req)) {
      return json({ error: "Your listing doesn't match this request." }, 403);
    }
    const already = await store.rows("enquiries", { kind: "pitch", post_id: listing.id, request_id: req.id });
    if (already.length) return json({ error: "You've already sent this listing to them." }, 409);
    const [e] = await store.insert("enquiries", { kind: "pitch", post_id: listing.id, request_id: req.id, from_user: user.id, to_user: req.user_id, message: clean(body.message, 500) });
    await notifyMany(deps, [{ user_id: req.user_id, kind: "pitch", post_id: listing.id, ref_id: e.id,
      title: `A listing for your request: ${postTitle(listing)}`,
      body: `${profile.name || "A lister"} thinks their ${postTitle(listing)} fits what you're looking for.${e.message ? " " + e.message : ""}` }]);
    return json({ ok: true });
  }

  /* ---------- your enquiries (sent and received), and answering a viewing request ---------- */
  if (path === "/enquiries" && method === "GET") {
    const received = await store.rows("enquiries", { to_user: user.id }, { order: "created_at", limit: 50 });
    const sent = await store.rows("enquiries", { from_user: user.id }, { order: "created_at", limit: 50 });
    return json({ received, sent });
  }
  const answer = path.match(/^\/enquiries\/([^/]+)$/);
  if (answer && method === "POST") {
    const body = await read();
    if (!isUuid(answer[1])) return json({ error: "Not found" }, 404);
    const [e] = await store.rows("enquiries", { id: answer[1] });
    if (!e || e.to_user !== user.id) return json({ error: "Not found" }, 404);
    if (e.kind !== "viewing") return json({ error: "Only viewing requests can be accepted or declined." }, 400);
    const status = body.status === "accepted" ? "accepted" : body.status === "declined" ? "declined" : null;
    if (!status) return json({ error: "Please accept or decline." }, 400);
    await store.update("enquiries", { id: e.id }, { status });
    const post = await store.getPost(e.post_id);
    const when = e.slot ? new Date(e.slot).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai", timeZoneName: "short" }) : "";
    await notifyMany(deps, [{ user_id: e.from_user, kind: `viewing_${status}`, post_id: e.post_id, ref_id: e.id,
      title: status === "accepted" ? `Viewing confirmed: ${when}` : "Viewing request declined",
      body: status === "accepted"
        ? `${profile.name || "The lister"} confirmed your viewing of the ${post ? postTitle(post) : "property"}. Their number is in your notifications.`
        : `${profile.name || "The lister"} can't do that time. Try another time, or call them.` }]);
    return json({ ok: true, status });
  }

  /* ---------- landlord tools: tenancies ---------- */
  if (path === "/tenancies" && method === "GET") {
    return json({ tenancies: await store.rows("tenancies", { user_id: user.id }, { order: "created_at", asc: true }) });
  }
  const tenancyFields = (b) => {
    const due = toInt(b.due_day, 1, 28);
    const end = b.lease_end && /^\d{4}-\d{2}-\d{2}$/.test(b.lease_end) ? b.lease_end : null;
    const email = String(b.tenant_email || "").trim().toLowerCase().slice(0, 120);
    return {
      label: clean(b.label, 80), tenant_name: clean(b.tenant_name, 60), tenant_phone: cleanPhone(b.tenant_phone),
      tenant_email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
      rent: toInt(b.rent, 1, 1e10), currency: b.currency ? String(b.currency).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) : null,
      due_day: due, lease_end: end
    };
  };
  if (path === "/tenancies" && method === "POST") {
    const body = await read();
    const f = tenancyFields(body);
    if (!f.label) return json({ error: "Please name the property, e.g. 'Skyview 1204'." }, 400);
    if ((await store.rows("tenancies", { user_id: user.id })).length >= 50) return json({ error: "You can track up to 50 tenancies." }, 400);
    const [row] = await store.insert("tenancies", { ...f, user_id: user.id, repair_token: newToken() });
    return json({ tenancy: row });
  }
  const ten = path.match(/^\/tenancies\/([^/]+)$/);
  if (ten && isUuid(ten[1])) {
    const [t] = await store.rows("tenancies", { id: ten[1], user_id: user.id });
    if (!t) return json({ error: "Not found" }, 404);
    if (method === "PATCH") {
      const body = await read();
      const f = tenancyFields({ ...t, ...body });
      if (!f.label) return json({ error: "Please name the property." }, 400);
      const reset = {};
      if (f.lease_end !== t.lease_end) reset.renewal_reminded = false;
      if (body.new_link) reset.repair_token = newToken();
      const [row] = await store.update("tenancies", { id: t.id }, { ...f, ...reset });
      return json({ tenancy: row });
    }
    if (method === "DELETE") {
      await store.remove("tenancies", { id: t.id });
      return json({ ok: true });
    }
  }

  /* ---------- admin ---------- */
  if (path === "/admin/flags" && method === "GET") {
    if (!isAdmin) return json({ error: "Admins only." }, 403);
    const all = await store.activePosts();
    return json({ posts: all.filter((p) => Array.isArray(p.flags) && p.flags.length).map((p) => ({ id: p.id, title: postTitle(p), flags: p.flags, contact_name: p.contact_name, created_at: p.created_at })) });
  }
  if (path === "/admin/test-email" && method === "POST") {
    if (!isAdmin) return json({ error: "Admins only." }, 403);
    if (!deps.mail) return json({ ok: false, error: "No BREVO_API_KEY is set on the server." });
    const site = (deps.env && deps.env.SITE_URL) || "https://propertystalkers.com";
    const r = await deps.mail.send([{ email: profile.email || user.email, name: profile.name, title: "Test email from Property Stalkers",
      body: "If you can read this, email notifications are working.", link: site }]);
    await notifyMany({ ...deps, mail: null }, [{ user_id: user.id, kind: "test", title: "Test notification", body: r && r.ok ? "A test email was sent to " + (profile.email || user.email) + "." : "The bell works. The email could not be sent: " + ((r && r.error) || "unknown error") }]);
    return json({ ok: !!(r && r.ok), status: r && r.status, error: r && r.error });
  }
  if (path === "/admin/run-jobs" && method === "POST") {
    if (!isAdmin) return json({ error: "Admins only." }, 403);
    return json({ done: await runJobs(deps) });
  }

  return null;
}
