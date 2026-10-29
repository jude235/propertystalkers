// What happens after a post is published or changed: alerts, the request matcher and price-drop alerts.
import { marketInfo, matchesCriteria, listingFitsRequest, describeCriteria } from "./market.mjs";
import { notifyMany } from "./notify.mjs";
import { sharedInterests, INTEREST_LABEL } from "./core.mjs";

const MAX_PER_EVENT = 40;

function money(p) {
  if (!p.price) return "";
  return `${p.currency || "INR"} ${Number(p.price).toLocaleString("en-US")}${p.deal === "rent" || p.deal === "share" ? "/month" : p.deal === "stay" ? "/night" : ""}`;
}
const ROOM = { private_room: "private room", shared_room: "shared room", bed_space: "bed space", whole_unit: "flat to share" };
export function postTitle(p) {
  if (p.deal === "share") {
    const where = [p.building, p.locality, p.city].filter(Boolean).join(", ");
    const r = ROOM[p.room_type] || "room";
    return p.kind === "request" ? `looking for a ${r === "flat to share" ? "flat to share" : r + " to share"}${where ? " in " + where : ""}` : `${r === "flat to share" ? "Flat to share" : r[0].toUpperCase() + r.slice(1) + " to share"}${where ? " in " + where : ""}`;
  }
  if (p.deal === "stay") {
    const where = [p.building, p.locality, p.city].filter(Boolean).join(", ");
    return `${p.bedrooms ? p.bedrooms + " BHK holiday home" : "Holiday home"}${where ? " in " + where : ""}`;
  }
  const t = { apartment: "apartment", villa: "villa", independent_house: "house", plot: "plot", office: "office", shop: "shop", warehouse: "warehouse" }[p.property_type] || "property";
  const what = p.poster_type === "developer" ? (p.building || "New project") : `${p.bedrooms ? p.bedrooms + " BHK " : ""}${t}`;
  const where = [p.building && p.poster_type !== "developer" ? p.building : null, p.locality, p.city].filter(Boolean).join(", ");
  return `${what}${p.kind === "listing" && p.poster_type !== "developer" ? (p.deal === "rent" ? " for rent" : " for sale") : ""}${where ? " in " + where : ""}`;
}

/** A listing went live (new, re-activated, or edited so it may now match more searches). */
export async function onListingLive(deps, post, { previous = null } = {}) {
  const { store } = deps;
  const all = await store.activePosts();
  const info = marketInfo(all);
  const i = info.get(post.id) || null;
  const out = [];
  // Saved searches ("alert me when...").
  const searches = await store.rows("saved_searches", {}, { limit: 2000 });
  for (const s of searches) {
    if (s.user_id === post.user_id) continue;
    if (!matchesCriteria(post, s.criteria, i)) continue;
    if (previous && matchesCriteria(previous, s.criteria, i)) continue; // they were already told
    out.push({ user_id: s.user_id, kind: "alert", post_id: post.id,
      title: `New match: ${postTitle(post)}`, body: `${money(post)}${money(post) ? " · " : ""}matches your alert "${s.label}".` });
  }
  // Buyers and tenants whose request this listing fits.
  if (!previous) {
    for (const r of all) {
      if (r.kind !== "request" || r.user_id === post.user_id) continue;
      if (!listingFitsRequest(post, r)) continue;
      const common = post.deal === "share" ? sharedInterests(post.interests, r.interests) : [];
      const like = common.length ? ` You have ${common.length} thing${common.length > 1 ? "s" : ""} in common: ${common.slice(0, 4).map((x) => INTEREST_LABEL[x] || x).join(", ")}.` : "";
      out.push({ user_id: r.user_id, kind: "match", post_id: post.id, ref_id: r.id,
        title: `A listing fits your request: ${postTitle(post)}`, body: `${money(post)}.${like} Open it on the map to see details and contact the lister.` });
    }
  }
  return notifyMany(deps, out.slice(0, MAX_PER_EVENT));
}

/** A buyer / tenant request went live: tell owners and brokers whose listing fits, so they can pitch it. */
export async function onRequestLive(deps, req) {
  const { store } = deps;
  const all = await store.activePosts();
  const out = [];
  for (const l of all) {
    if (l.kind !== "listing" || l.user_id === req.user_id) continue;
    if (!listingFitsRequest(l, req)) continue;
    out.push({ user_id: l.user_id, kind: "pitch_invite", post_id: l.id, ref_id: req.id,
      title: `Someone is looking for a place like yours`,
      body: `A ${req.poster_type === "tenant" ? "tenant" : "buyer"} wants ${postTitle(req).replace(/ for (sale|rent)/, "")}${req.price ? `, budget ${money(req)}` : ""}. Your ${postTitle(l)} fits. Tap to send it to them.` });
  }
  return notifyMany(deps, out.slice(0, MAX_PER_EVENT));
}

/** The price changed: watchers hear about drops; alerts that only now fit are told too. */
export async function onPriceChange(deps, post, oldPrice) {
  const { store } = deps;
  const out = [];
  if (oldPrice && post.price && post.price < oldPrice) {
    const watchers = await store.rows("watches", { post_id: post.id });
    const pct = Math.round(((oldPrice - post.price) / oldPrice) * 100);
    for (const w of watchers) {
      if (w.user_id === post.user_id) continue;
      out.push({ user_id: w.user_id, kind: "price_drop", post_id: post.id,
        title: `Price dropped ${pct}%: ${postTitle(post)}`,
        body: `Now ${money(post)} (was ${money({ ...post, price: oldPrice })}).` });
    }
  }
  await notifyMany(deps, out.slice(0, MAX_PER_EVENT));
  return onListingLive(deps, post, { previous: { ...post, price: oldPrice } });
}
