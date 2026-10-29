// Business rules: validation, who-can-see-what, and what the browser receives.

export const POSTER_TYPES = ["landlord", "broker", "developer", "buyer", "tenant"];
export const PROPERTY_TYPES = ["apartment", "villa", "independent_house", "plot", "office", "shop", "warehouse", "other"];
export const COMMERCIAL_TYPES = ["office", "shop", "warehouse"];

export const LIMITS = {
  importBatch: 10,       // DLD projects per admin import call (keeps each call under the host's request cap)
  aiCallsPerDay: 40,     // AI messages per user per day
  postsPerDay: 10,       // confirmed posts per user per day
  maxPhotos: 8,
  listingsPerUnit: 3,    // the same unit can be listed at most this many times for sale, and again for rent
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
const RERA_RE = /^[A-Z0-9][A-Z0-9/\-. #:]{1,58}[A-Z0-9]$/;  // any licence / BRN / RERA format, 3+ chars with a digit
export function cleanRera(r) {
  const s = clean(r, 60);
  if (!s) return null;
  const up = s.toUpperCase();
  return RERA_RE.test(up) && /\d/.test(up) ? up : null;
}

/** Unit / flat / villa number as typed, tidied for display. */
export function cleanUnit(u) {
  const s = clean(u, 30);
  return s && /[A-Za-z0-9]/.test(s) ? s : null;
}

/** "Unit 1204", "Flat #1204" and "1204" are the same unit. */
export function unitNorm(u) {
  return String(u || "").toLowerCase()
    .replace(/\b(unit|flat|apartment|apt|villa|office|shop|plot|no|number|num)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** One key per unit and deal: the same unit is counted separately for sale and for rent. */
export function unitKey({ deal, building, locality, city, unit_number }) {
  const place = buildingKey(building || locality, city);
  const n = unitNorm(unit_number);
  return place && n && deal ? `${deal}|${place}|${n}` : null;
}

/** Listings of one unit share the map: the cheapest first, then whoever listed first. */
export function unitOrder(a, b) {
  const pa = a.price == null ? Infinity : Number(a.price), pb = b.price == null ? Infinity : Number(b.price);
  if (pa !== pb) return pa - pb;
  return String(a.created_at).localeCompare(String(b.created_at));
}

/** Who gets the next lead for a unit: the cheapest listers take turns, in the order they listed. */
export function leadPool(group) {
  const sorted = [...group].sort(unitOrder);
  if (!sorted.length) return [];
  const best = sorted[0].price;
  return sorted.filter((p) => p.price === best);
}

/**
 * The map shows one listing per unit (the cheapest; on a tie, the earliest).
 * People who listed the unit see only their own listing of it; admins see all of them.
 */
export function collapseUnits(posts, viewer) {
  if (viewer && viewer.isAdmin) return posts;
  const groups = new Map();
  for (const p of posts) {
    if (p.kind !== "listing" || !p.unit_key || p.status !== "active") continue;
    if (!groups.has(p.unit_key)) groups.set(p.unit_key, []);
    groups.get(p.unit_key).push(p);
  }
  const hide = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mineHere = viewer && group.some((p) => p.user_id === viewer.id);
    const shown = mineHere ? group.filter((p) => p.user_id === viewer.id) : [group.slice().sort(unitOrder)[0]];
    for (const p of group) if (!shown.includes(p)) hide.add(p.id);
  }
  return posts.filter((p) => !hide.has(p.id));
}

export function cleanPhone(p) {
  const raw = String(p || "").trim();
  let d = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return d.length >= 8 && d.length <= 15 ? d : null;   // already international
  if (d.startsWith("00")) d = d.slice(2);                                          // 00971… style
  else if (d.length === 11 && /^0[6-9]/.test(d)) d = "91" + d.slice(1);           // Indian 0-prefixed mobile
  else if (d.length === 10 && /^[6-9]/.test(d)) d = "91" + d;                      // Indian 10-digit mobile
  else if (d.startsWith("0")) return null;                                         // local number without country code
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** Three-letter currency code such as INR, AED, USD, GBP. */
export function cleanCurrency(c) {
  const s = String(c || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
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
    return { ok: false, ask: "Are you the landlord, a broker, a developer, a buyer or a tenant?" };
  }

  let poster_type = poster;
  let rera_number = null;
  const notes = [];
  let company = null;
  if (poster === "broker") {
    rera_number = cleanRera(input.rera_number);
    if (!rera_number) {
      poster_type = "landlord";
      notes.push("No valid broker licence / RERA number was given, so this will be posted as Landlord.");
    }
  }
  if (poster === "developer") {
    company = clean(input.company, 80);
    if (!company) return { ok: false, ask: "What is the name of the developer company?" };
    rera_number = cleanRera(input.rera_number); // project registration, optional
  }

  const kind = poster_type === "buyer" || poster_type === "tenant" ? "request" : "listing";
  let deal;
  if (poster_type === "buyer") deal = "sale";
  else if (poster_type === "tenant") deal = "rent";
  else if (poster_type === "developer") deal = String(input.deal || "").toLowerCase() === "rent" ? "rent" : "sale";
  else {
    deal = String(input.deal || "").toLowerCase();
    if (!["sale", "rent"].includes(deal)) {
      return { ok: false, ask: "Do you want to sell it or rent it out?" };
    }
  }

  const building = clean(input.building, 100);
  const locality = clean(input.locality, 100);
  const city = clean(input.city, 60);
  const country = clean(input.country, 60);
  if (!building && !locality) {
    return { ok: false, ask: "Where is the property? Please share the building or project name and the area, sector or community." };
  }
  if (!city) {
    return { ok: false, ask: "Which city is that in?" };
  }

  const property_type = PROPERTY_TYPES.includes(input.property_type) ? input.property_type : "other";
  const size_sqft = toInt(input.size_sqft, 1, 100_000_000);
  const unit_number = kind === "listing" && poster_type !== "developer" ? cleanUnit(input.unit_number) : null;
  if (kind === "listing" && poster_type !== "developer") {
    if (!unit_number) {
      return { ok: false, ask: "What's the unit, flat or villa number? It's never shown to visitors; it only stops the same unit being listed too many times." };
    }
    if (!size_sqft) return { ok: false, ask: "What's the size of the property in sq ft?" };
  }
  const price = toInt(input.price, 1, 100_000_000_000);
  const currency = cleanCurrency(input.currency) || (price ? "INR" : null);

  return {
    ok: true,
    post: {
      kind,
      poster_type,
      deal,
      property_type,
      bedrooms: toInt(input.bedrooms, 0, 20),
      price,
      currency,
      building,
      locality,
      city,
      country,
      rera_number,
      company,
      possession: poster_type === "developer" ? clean(input.possession, 40) : null,
      configs: poster_type === "developer" ? clean(input.configs, 80) : null,
      unit_number,
      size_sqft,
      maps_link: cleanMapsLink(input.maps_link),
      description: clean(input.description, 400),
      notes
    }
  };
}

/* ---------------- visibility ---------------- */

/** Everything we need to know about the person looking at the map. */
export function makeViewer({ user, profile, isAdmin = false }) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    isAdmin,
    // Brokers see requests only while acting as a broker (switching role turns it off).
    isBroker: !!(profile && profile.rera_number && (!profile.role || profile.role === "broker"))
  };
}

/**
 * The rules:
 * - Listings (landlord / broker / developer) are public.
 * - Buyer and tenant requests are visible only to brokers who gave a licence / RERA number.
 * - You always see your own posts; admins see everything.
 */
export function canSee(post, viewer) {
  if (post.status !== "active") return false;
  if (post.kind === "listing") return true;
  if (!viewer) return false;
  return viewer.isAdmin || viewer.isBroker || post.user_id === viewer.id;
}

export function accessSummary(viewer) {
  return { requests: !!(viewer && (viewer.isAdmin || viewer.isBroker)) };
}

/** What the browser receives. Internal fields and user ids never leave the server. */
export function toPublic(post, viewer) {
  const mine = !!viewer && post.user_id === viewer.id;
  const insider = mine || !!(viewer && viewer.isAdmin);
  // Unit listings hand out the contact when someone taps Call or WhatsApp, so leads can take turns.
  const gated = post.kind === "listing" && !!post.unit_key && !insider;
  return {
    id: post.id,
    kind: post.kind,
    poster_type: post.poster_type,
    deal: post.deal,
    property_type: post.property_type,
    bedrooms: post.bedrooms,
    price: post.price,
    currency: post.currency || "INR",
    building: post.building,
    locality: post.locality,
    city: post.city,
    country: post.country,
    address: post.address,
    lat: post.lat,
    lng: post.lng,
    precision: post.precision,
    rera_number: post.rera_number,
    company: post.company,
    possession: post.possession,
    configs: post.configs,
    size_sqft: post.size_sqft ?? null,
    unit_number: insider ? post.unit_number || null : null,
    contact_on_tap: gated,
    description: post.description,
    photos: Array.isArray(post.photos) ? post.photos : [],
    contact_name: gated ? null : post.contact_name,
    contact_phone: gated ? null : post.contact_phone,
    contact_avatar: gated ? null : post.contact_avatar || null,
    created_at: post.created_at,
    source: String(post.building_key || "").startsWith("dld:") ? "dld" : null,
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
    const images = m.role === "user" && Array.isArray(m.images) ? m.images.filter((u) => typeof u === "string" && u.length < 400).slice(0, 4) : [];
    if (!content && !images.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = [last.content, content].filter(Boolean).join("\n");
      if (images.length) last.images = [...(last.images || []), ...images].slice(0, 4);
    } else out.push(images.length ? { role: m.role, content: content || "(photos)", images } : { role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** Only Google Maps links are accepted for exact pins. */
export function cleanMapsLink(u) {
  const s = String(u || "").trim();
  if (s.length > 600) return null;
  return /^https:\/\/((www\.|maps\.)?google\.[a-z.]{2,8}\/maps|maps\.app\.goo\.gl\/|goo\.gl\/maps\/|maps\.google\.[a-z.]{2,8}\/)/i.test(s) ? s : null;
}
