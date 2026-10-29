// Matching and market maths shared by search, alerts, the request matcher, deal badges and safety checks.

export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

const TYPE_CLASS = {
  apartment: "home", villa: "home", independent_house: "home", other: "home",
  office: "commercial", shop: "commercial", warehouse: "commercial", plot: "land"
};
export const typeClass = (t) => TYPE_CLASS[t] || "home";
const sameType = (a, b) => a === b || (["villa", "independent_house"].includes(a) && ["villa", "independent_house"].includes(b));

const placeText = (p) => norm([p.building, p.locality, p.city, p.address].filter(Boolean).join(" "));

/** Every word of the place someone typed appears in the listing's building / area / city / address. */
export function placeMatches(post, text) {
  const want = norm(text);
  if (!want) return true;
  const have = ` ${placeText(post)} `;
  return want.split(" ").every((w) => have.includes(` ${w} `) || have.includes(` ${w}`));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const perSqft = (p) => (p.price && p.size_sqft ? p.price / p.size_sqft : null);

/**
 * Market picture for each listing, from comparable active listings: same deal, city, area (or building),
 * kind of property and currency. Needs at least 3 comparables with a size to say anything.
 * Returns Map(post id -> { comps, median_psf, below_pct, cut_pct, deal }).
 */
export function marketInfo(posts) {
  const listings = posts.filter((p) => p.kind === "listing" && p.status === "active" && p.poster_type !== "developer");
  const groups = new Map();
  const keyOf = (p) => [p.deal, norm(p.city), norm(p.locality || p.building), typeClass(p.property_type), p.currency || ""].join("|");
  for (const p of listings) {
    const k = keyOf(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const out = new Map();
  for (const p of posts) {
    const cut = p.first_price && p.price && p.price < p.first_price ? Math.round(((p.first_price - p.price) / p.first_price) * 100) : 0;
    let below = 0, med = null, comps = 0;
    if (p.kind === "listing" && p.poster_type !== "developer") {
      const others = (groups.get(keyOf(p)) || []).filter((o) => o.id !== p.id && !(p.unit_key && o.unit_key === p.unit_key));
      const psfs = others.map(perSqft).filter(Boolean);
      comps = psfs.length;
      if (comps >= 3 && perSqft(p)) {
        med = median(psfs);
        below = Math.round(((med - perSqft(p)) / med) * 100);
      }
    }
    out.set(p.id, { comps, median_psf: med ? Math.round(med) : null, below_pct: below, cut_pct: cut, deal: below >= 10 || cut >= 5 });
  }
  return out;
}

/** "cheap / fair / overpriced" for a price per sq ft against the area's median. */
export function priceVerdict(psf, medianPsf) {
  if (!psf || !medianPsf) return null;
  const diff = Math.round(((psf - medianPsf) / medianPsf) * 100);
  return { diff_pct: diff, verdict: diff <= -10 ? "cheap" : diff >= 10 ? "overpriced" : "fair" };
}

export function areaStats(posts, { deal, city, area, property_type, bedrooms, currency } = {}) {
  const pool = posts.filter((p) => p.kind === "listing" && p.status === "active" && p.poster_type !== "developer"
    && (!deal || p.deal === deal)
    && (!city || norm(p.city) === norm(city))
    && (!area || placeMatches(p, area))
    && (!property_type || typeClass(p.property_type) === typeClass(property_type))
    && (!bedrooms || p.bedrooms === bedrooms)
    && (!currency || p.currency === currency));
  const prices = pool.map((p) => p.price).filter(Boolean);
  const psf = pool.map(perSqft).filter(Boolean);
  return {
    listings: pool.length,
    currency: currency || (pool[0] && pool[0].currency) || null,
    median_price: prices.length ? Math.round(median(prices)) : null,
    min_price: prices.length ? Math.min(...prices) : null,
    max_price: prices.length ? Math.max(...prices) : null,
    median_price_per_sqft: psf.length ? Math.round(median(psf)) : null
  };
}

/**
 * Search / alert criteria:
 * { kind, deal, category: home|commercial|land|project, types[], min_bedrooms, max_bedrooms, min_price, max_price,
 *   currency, min_size, max_size, city, area, deals_only, cobroke_only }
 */
export function matchesCriteria(p, c = {}, info = null) {
  if (p.status !== "active") return false;
  if ((c.kind || "listing") !== p.kind) return false;
  if (c.deal && p.deal !== c.deal) return false;
  if (c.category === "project" && p.poster_type !== "developer") return false;
  if (c.category && c.category !== "project" && typeClass(p.property_type) !== c.category) return false;
  if (Array.isArray(c.types) && c.types.length && !c.types.some((t) => sameType(t, p.property_type))) return false;
  if (c.min_bedrooms && !(p.bedrooms >= c.min_bedrooms)) return false;
  if (c.max_bedrooms && !(p.bedrooms <= c.max_bedrooms)) return false;
  if (c.currency && p.currency && c.currency !== p.currency && (c.min_price || c.max_price)) return false;
  if (c.min_price && !(p.price >= c.min_price)) return false;
  if (c.max_price && !(p.price && p.price <= c.max_price)) return false;
  if (c.min_size && !(p.size_sqft >= c.min_size)) return false;
  if (c.max_size && !(p.size_sqft && p.size_sqft <= c.max_size)) return false;
  if (c.city && norm(p.city) !== norm(c.city)) return false;
  if (c.area && !placeMatches(p, c.area)) return false;
  if (c.deals_only && !(info && info.deal)) return false;
  if (c.cobroke_only && !p.cobroke) return false;
  return true;
}

/** Plain-words summary of criteria, for alert names and messages. */
export function describeCriteria(c = {}) {
  const what = c.category === "project" ? "new projects"
    : c.category === "commercial" ? "commercial property"
    : c.category === "land" ? "land / plots"
    : (c.min_bedrooms ? `${c.min_bedrooms}+ bed ` : "") + (Array.isArray(c.types) && c.types.length ? c.types.join(" / ") : "homes");
  const deal = c.deal === "rent" ? " to rent" : c.deal === "sale" ? " for sale" : "";
  const where = [c.area, c.city].filter(Boolean).join(", ");
  const money = c.max_price ? ` up to ${c.currency || ""} ${Number(c.max_price).toLocaleString("en-US")}`.replace("  ", " ") : "";
  return `${c.deals_only ? "Deals on " : ""}${what}${deal}${where ? " in " + where : ""}${money}`.trim();
}

/** Does this listing fit what this buyer / tenant asked for? */
export function listingFitsRequest(listing, req) {
  if (listing.kind !== "listing" || req.kind !== "request") return false;
  if (listing.status !== "active" || req.status !== "active") return false;
  if (listing.deal !== req.deal) return false;
  if (norm(listing.city) !== norm(req.city)) return false;
  if (req.building && req.building_key && listing.building_key === req.building_key) {
    // same building: fine
  } else if (req.locality) {
    const a = norm(listing.locality), b = norm(req.locality);
    if (!(a && b && (a.includes(b) || b.includes(a))) && !placeMatches(listing, req.locality)) return false;
  } else if (req.building) {
    if (!placeMatches(listing, req.building)) return false;
  }
  if (req.bedrooms && listing.bedrooms && !(listing.bedrooms >= req.bedrooms && listing.bedrooms <= req.bedrooms + 1)) return false;
  if (req.property_type && req.property_type !== "other" && listing.property_type && listing.property_type !== "other"
    && !sameType(req.property_type, listing.property_type)) return false;
  if (req.price && listing.price && (req.currency || "INR") === (listing.currency || "INR") && listing.price > req.price * 1.1) return false;
  return true;
}

/* ---------------- safety and moderation ---------------- */

const PAYMENT_RED_FLAGS = /western union|moneygram|gift ?cards?|bitcoin|crypto|usdt|wire (the )?(deposit|money|advance)|send (the |a )?(deposit|money|advance|token)|(deposit|advance|token)\W.{0,30}before (the )?(viewing|visit|seeing)|without (viewing|visiting|seeing)|i('| a)?m (currently )?(abroad|overseas|out of (the )?country)|keys? (by|via|through) (post|courier|mail)/i;
const CONTACT_IN_TEXT = /(\+?\d[\d\s-]{8,}\d)|([^\s@]+@[^\s@]+\.[a-z]{2,})|(https?:\/\/|www\.)/i;

/** Flags stored on a post when it is created or edited. */
export function textFlags(p) {
  const text = `${p.description || ""} ${p.building || ""}`;
  const flags = [];
  if (PAYMENT_RED_FLAGS.test(text)) flags.push("payment_red_flag");
  if (CONTACT_IN_TEXT.test(p.description || "")) flags.push("contact_in_text");
  const letters = (p.description || "").replace(/[^A-Za-z]/g, "");
  if (letters.length > 30 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7) flags.push("shouting");
  if (/(.)\1{6,}/.test(p.description || "")) flags.push("spam_text");
  const uae = /emirates|uae|dubai|abu dhabi|sharjah|ajman/i.test(`${p.country || ""} ${p.city || ""}`);
  if (uae && p.kind === "listing" && p.poster_type === "broker" && !/permit|trakheesi|madmoun/i.test(p.description || "")) flags.push("ad_permit_missing");
  return flags;
}

export const FLAG_TEXT = {
  payment_red_flag: "The description asks for money in a way scammers often do (deposit before viewing, wire transfer, crypto or gift cards). Never pay before you have seen the property and checked who owns it.",
  far_below_market: "This price is far below similar listings nearby. That can be a great deal, but it is also a common scam pattern. View in person before paying anything.",
  contact_in_text: "Contact details were written into the description.",
  shouting: "The description is mostly in capital letters.",
  spam_text: "The description looks like spam.",
  ad_permit_missing: "Dubai property ads need an advertising permit (Trakheesi / Madmoun) number. Add it to the description."
};
/** Which flags visitors are warned about (the others are for the owner and the admin). */
export const PUBLIC_FLAGS = ["payment_red_flag", "far_below_market"];
