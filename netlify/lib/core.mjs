// Business rules: validation, who-can-see-what, and what the browser receives.

export const POSTER_TYPES = ["landlord", "broker", "buyer", "tenant"];
export const PROPERTY_TYPES = ["apartment", "villa", "independent_house", "plot", "office", "shop", "other"];

export const LIMITS = {
  aiCallsPerDay: 40,     // AI messages per user per day
  postsPerDay: 10,       // confirmed posts per user per day
  maxPhotos: 8,
  maxMessages: 24,       // chat history sent to the AI
  maxMessageChars: 1500
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === "string" && UUID_RE.test(s);

export function clean(s, max = 120) {
  if (s === null || s === undefined) return null;
  const v = String(s).replace(/\s+/g, " ").trim().slice(0, max);
  return v || null;
}

export function buildingKey(building, city) {
  const b = String(building || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const c = String(city || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return b && c ? `${b}|${c}` : null;
}

// RERA numbers vary by state (e.g. P51700012345, PRM/KA/RERA/1251/309/PR/..., RC/REP/HARERA/GGM/...).
// We only check it looks like a registration number; it cannot be verified automatically.
const RERA_RE = /^[A-Z0-9][A-Z0-9/\-. ]{4,58}[A-Z0-9]$/;
export function cleanRera(r) {
  const s = clean(r, 60);
  if (!s) return null;
  const up = s.toUpperCase();
  return RERA_RE.test(up) && /\d/.test(up) ? up : null;
}

export function cleanPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = "91" + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

function toInt(v, min, max) {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * Check what the AI proposed. Returns { ok: true, post } or { ok: false, ask } where
 * `ask` is the question to send back to the user.
 */
export function validateProposal(input = {}) {
  const poster = String(input.poster_type || "").toLowerCase();
  if (!POSTER_TYPES.includes(poster)) {
    return { ok: false, ask: "Are you the landlord, a broker, a buyer or a tenant?" };
  }

  let poster_type = poster;
  let rera_number = null;
  const notes = [];
  if (poster === "broker") {
    rera_number = cleanRera(input.rera_number);
    if (!rera_number) {
      poster_type = "landlord";
      notes.push("No valid broker RERA number was given, so this will be posted as Landlord.");
    }
  }

  const kind = poster_type === "buyer" || poster_type === "tenant" ? "request" : "listing";
  let deal;
  if (poster_type === "buyer") deal = "sale";
  else if (poster_type === "tenant") deal = "rent";
  else {
    deal = String(input.deal || "").toLowerCase();
    if (!["sale", "rent"].includes(deal)) {
      return { ok: false, ask: "Do you want to sell it or rent it out?" };
    }
  }

  const building = clean(input.building, 100);
  const locality = clean(input.locality, 100);
  const city = clean(input.city, 60);
  if (!building && !locality) {
    return { ok: false, ask: "Where is the property? Please share the building or project name and the sector or area." };
  }
  if (!city) {
    return { ok: false, ask: "Which city is that in?" };
  }

  const property_type = PROPERTY_TYPES.includes(input.property_type) ? input.property_type : "other";

  return {
    ok: true,
    post: {
      kind,
      poster_type,
      deal,
      property_type,
      bedrooms: toInt(input.bedrooms, 0, 20),
      price: toInt(input.price, 1000, 100_000_000_000),
      building,
      locality,
      city,
      rera_number,
      description: clean(input.description, 400),
      notes
    }
  };
}

/* ---------------- visibility ---------------- */

function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Everything we need to know about the person looking at the map. */
export function makeViewer({ user, profile, myPosts = [], isAdmin = false }) {
  if (!user) return null;
  const myListings = myPosts.filter((p) => p.kind === "listing" && p.status === "active");
  return {
    id: user.id,
    email: user.email,
    isAdmin,
    isBroker: !!(profile && profile.rera_number),
    isSeller: myListings.length > 0,
    buildingKeys: new Set(myListings.map((p) => p.building_key).filter(Boolean)),
    placeIds: new Set(myListings.filter((p) => p.precision === "building" && p.place_id).map((p) => p.place_id)),
    buildingPoints: myListings.filter((p) => p.precision === "building").map((p) => ({ lat: p.lat, lng: p.lng }))
  };
}

/** Does the viewer have a listed property in the same building as this post? */
export function ownsInBuilding(viewer, post) {
  if (!viewer || post.precision !== "building") {
    // A sector-level request has no building to match against.
    return !!(viewer && post.building_key && viewer.buildingKeys.has(post.building_key));
  }
  if (post.building_key && viewer.buildingKeys.has(post.building_key)) return true;
  if (post.place_id && viewer.placeIds.has(post.place_id)) return true;
  return viewer.buildingPoints.some((pt) => metres(pt, post) <= 60);
}

/**
 * The rules:
 * - Listings (landlord / broker) are public.
 * - Buyer requests: brokers with a RERA number and landlords who have listed a property.
 * - Tenant requests: brokers with a RERA number, or people with a listed property in that building.
 * - You always see your own posts; admins see everything.
 */
export function canSee(post, viewer) {
  if (post.status !== "active") return false;
  if (post.kind === "listing") return true;
  if (!viewer) return false;
  if (viewer.isAdmin || post.user_id === viewer.id) return true;
  if (post.poster_type === "buyer") return viewer.isBroker || viewer.isSeller;
  if (post.poster_type === "tenant") return viewer.isBroker || ownsInBuilding(viewer, post);
  return false;
}

export function accessSummary(viewer) {
  if (!viewer) return { buyerRequests: false, tenantRequests: "none" };
  const all = viewer.isAdmin || viewer.isBroker;
  return {
    buyerRequests: all || viewer.isSeller,
    tenantRequests: all ? "all" : viewer.buildingKeys.size || viewer.buildingPoints.length ? "own_buildings" : "none"
  };
}

/** What the browser receives. Internal fields and user ids never leave the server. */
export function toPublic(post, viewer) {
  const mine = !!viewer && post.user_id === viewer.id;
  return {
    id: post.id,
    kind: post.kind,
    poster_type: post.poster_type,
    deal: post.deal,
    property_type: post.property_type,
    bedrooms: post.bedrooms,
    price: post.price,
    building: post.building,
    locality: post.locality,
    city: post.city,
    address: post.address,
    lat: post.lat,
    lng: post.lng,
    precision: post.precision,
    rera_number: post.rera_number,
    description: post.description,
    photos: Array.isArray(post.photos) ? post.photos : [],
    contact_name: post.contact_name,
    contact_phone: post.contact_phone,
    created_at: post.created_at,
    mine,
    removable: mine || !!(viewer && viewer.isAdmin)
  };
}

/** Keep only well-formed chat turns, newest last, starting with the user. */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages.slice(-LIMITS.maxMessages)) {
    if (!m || !["user", "assistant"].includes(m.role)) continue;
    const content = String(m.content ?? "").slice(0, LIMITS.maxMessageChars).trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + content;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}
