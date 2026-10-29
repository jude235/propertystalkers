// Public pages that search engines, WhatsApp previews and AI assistants can read without running the map:
//   /property/<id>  one page per active listing (requests and drafts are never public)
//   /sitemap.xml    every listing the map shows to visitors
// Only what a signed-out visitor already sees on the map is used. No phone numbers, no unit numbers, no requests.
import { collapseUnits, toPublic, INTEREST_LABEL } from "./core.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const TYPE = { apartment: "apartment", villa: "villa", independent_house: "independent house", plot: "plot", office: "office", shop: "shop", warehouse: "warehouse", other: "" };
const ROOM = { private_room: "Private room", shared_room: "Shared room", bed_space: "Bed space", whole_unit: "Flat to share" };
const SUITS = { any: "Anyone", male: "Men", female: "Women", couples: "Couples" };
const POSTER = { landlord: "Owner", broker: "Broker", developer: "Developer", host: "Host", tenant: "Tenant" };
const AMENITIES = { wifi: "WiFi", ac: "AC", furnished: "Furnished", parking: "Parking", pool: "Pool", gym: "Gym", security: "24/7 security",
  balcony: "Balcony", lift: "Lift", power_backup: "Power backup", kitchen: "Modular kitchen", maid: "Housekeeping", laundry: "Laundry",
  meals: "Meals", pets: "Pet friendly", metro: "Near metro", garden: "Garden", view: "View" };
const SYMBOL = { INR: "₹", USD: "$", GBP: "£", EUR: "€" };
// schema.org type for the place itself.
const SCHEMA_TYPE = { apartment: "Apartment", villa: "SingleFamilyResidence", independent_house: "SingleFamilyResidence", plot: "Landform", office: "Place", shop: "Place", warehouse: "Place" };

const isDev = (p) => p.poster_type === "developer";
const what = (p) => {
  const t = TYPE[p.property_type] || "";
  return p.bedrooms ? `${p.bedrooms} BHK${t ? " " + t : ""}` : t || "property";
};
export function titleOf(p) {
  if (isDev(p)) return p.building || "New project";
  if (p.deal === "share") return p.room_type === "whole_unit" ? "Co-living flat" : `${ROOM[p.room_type] || "Room"} in co-living`;
  if (p.deal === "stay") return p.bedrooms ? `${p.bedrooms} BHK holiday home` : "Holiday home";
  return cap(`${what(p)} for ${p.deal === "rent" ? "rent" : "sale"}`);
}
export const placeOf = (p) => [isDev(p) ? null : p.building, p.locality, p.city].filter(Boolean).join(", ");
const fullPlace = (p) => [p.building, p.locality, p.city, p.country].filter(Boolean).join(", ");

/** "AED 1,250,000" in full: pages are read by people and machines, so no "1.25M" shorthand. */
function amount(p) {
  if (p.price == null) return "";
  const cur = p.currency || "INR";
  const n = Number(p.price).toLocaleString(cur === "INR" ? "en-IN" : "en-US");
  return SYMBOL[cur] ? SYMBOL[cur] + n : `${cur} ${n}`;
}
export function priceOf(p) {
  if (p.deal === "share") {
    const bills = p.bills_included === true ? ", bills included" : p.bills_included === false ? ", plus bills" : "";
    return p.price ? `${amount(p)} a month per person${bills}` : "Rent on request";
  }
  if (isDev(p)) return p.price ? `From ${amount(p)}` : "Price on request";
  if (p.deal === "stay") return p.price ? `${amount(p)} a night` : "Price on request";
  return p.price ? `${amount(p)}${p.deal === "rent" ? " a month" : ""}` : "Price on request";
}
function postedBy(p) {
  if (p.poster_type === "broker") return `Broker${p.rera_number ? ` · licence ${p.rera_number}` : ""}`;
  if (isDev(p)) return `Developer${p.company ? ` · ${p.company}` : ""}${p.rera_number ? ` · permit ${p.rera_number}` : ""}`;
  return POSTER[p.poster_type] || "Owner";
}
const day = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toISOString().slice(0, 10); };
const longDay = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); };
const lastChange = (p) => [p.created_at, p.price_changed_at, p.confirmed_at].filter(Boolean).map((x) => new Date(x)).filter((d) => !isNaN(d)).sort((a, b) => b - a)[0];

/** The listings a signed-out visitor sees on the map (one per unit, cheapest first). */
export function publicListings(posts) {
  return collapseUnits(posts.filter((p) => p.status === "active" && p.kind === "listing" && p.lat != null), null);
}

function summary(p) {
  const bits = [titleOf(p), placeOf(p) ? `in ${placeOf(p)}` : "", "·", priceOf(p)];
  if (p.size_sqft) bits.push(`· ${Number(p.size_sqft).toLocaleString("en-US")} sq ft`);
  let s = bits.filter(Boolean).join(" ").replace(" · ", ", ").replace(/\s+·\s+/g, ". ");
  const d = String(p.description || "").replace(/\s+/g, " ").trim();
  if (d) s += ". " + d;
  return s.length > 158 ? s.slice(0, 155).replace(/\s+\S*$/, "") + "…" : s;
}

function structuredData(p, url) {
  const place = {
    "@type": SCHEMA_TYPE[p.property_type] || "Accommodation",
    name: [p.building, p.locality, p.city].filter(Boolean).join(", ") || titleOf(p),
    address: { "@type": "PostalAddress", streetAddress: p.building || undefined, addressLocality: p.locality || p.city || undefined, addressRegion: p.locality ? p.city || undefined : undefined, addressCountry: p.country || undefined },
    geo: { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng }
  };
  if (p.bedrooms && place["@type"] !== "Place" && place["@type"] !== "Landform") place.numberOfBedrooms = p.bedrooms;
  if (p.size_sqft && place["@type"] !== "Place" && place["@type"] !== "Landform") place.floorSize = { "@type": "QuantitativeValue", value: Number(p.size_sqft), unitCode: "FTK", unitText: "sq ft" };
  if (p.photos && p.photos.length) place.image = p.photos.slice(0, 6);
  const data = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    name: `${titleOf(p)}${placeOf(p) ? " in " + placeOf(p) : ""}`,
    url,
    datePosted: p.created_at || undefined,
    description: String(p.description || "").slice(0, 600) || undefined,
    mainEntity: place
  };
  if (p.price != null) {
    data.offers = {
      "@type": "Offer",
      price: Number(p.price),
      priceCurrency: p.currency || "INR",
      businessFunction: p.deal === "sale" ? "http://purl.org/goodrelations/v1#Sell" : "http://purl.org/goodrelations/v1#LeaseOut",
      availability: "https://schema.org/InStock",
      url
    };
    if (p.deal !== "sale") data.offers.priceSpecification = { "@type": "UnitPriceSpecification", price: Number(p.price), priceCurrency: p.currency || "INR", unitCode: p.deal === "stay" ? "DAY" : "MON" };
  }
  return JSON.stringify(data, (k, v) => (v === undefined ? undefined : v)).replace(/</g, "\\u003c");
}

const LOGO = `<svg width="24" height="27" viewBox="0 0 24 27" aria-hidden="true"><path d="M12 26s-9-9.2-9-15.6a9 9 0 0 1 18 0C21 16.8 12 26 12 26z" fill="#d4af37"/><path d="M5.6 10.4Q12 4.4 18.4 10.4Q12 16.4 5.6 10.4Z" fill="#11352b"/><circle cx="12" cy="10.4" r="2.6" fill="#d4af37"/></svg>`;
const STYLE = `
  :root { --deep: #0b231c; --brand: #11352b; --brass: #d4af37; --bg: #fcfbf7; --soft: #f7f4eb; --ink: #17202a; --muted: #5f6b66; --line: #e7e1d1; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.55; }
  a { color: inherit; }
  header { background: var(--brand); border-bottom: 2px solid var(--brass); padding: calc(12px + env(safe-area-inset-top)) 16px 12px; }
  header a { display: inline-flex; align-items: center; gap: 10px; color: #fcfbf7; text-decoration: none; font-weight: 800; font-size: 18px; letter-spacing: -.01em; }
  main { max-width: 860px; margin: 0 auto; padding: 0 16px 120px; }
  .crumbs { font-size: 13px; color: var(--muted); padding: 14px 0 0; }
  .crumbs a { color: var(--muted); }
  .photos { display: flex; gap: 8px; overflow-x: auto; scroll-snap-type: x mandatory; margin: 14px -16px 0; padding: 0 16px; scrollbar-width: none; }
  .photos::-webkit-scrollbar { display: none; }
  .photos img { flex: 0 0 auto; width: min(86vw, 560px); aspect-ratio: 4 / 3; object-fit: cover; border-radius: 14px; scroll-snap-align: start; background: var(--soft); }
  .nophoto { margin-top: 14px; aspect-ratio: 16 / 7; border-radius: 14px; background: linear-gradient(135deg, var(--brand), var(--deep)); display: flex; align-items: center; justify-content: center; }
  h1 { font-size: clamp(24px, 5vw, 32px); line-height: 1.2; margin: 18px 0 4px; color: var(--brand); letter-spacing: -.02em; }
  .place { color: var(--muted); margin: 0; }
  .price { font-size: 24px; font-weight: 800; color: var(--brand); margin: 12px 0 0; }
  .tag { display: inline-block; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: var(--soft); border: 1px solid var(--line); margin: 10px 6px 0 0; }
  .facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin: 20px 0 0; padding: 0; }
  .facts div { background: var(--soft); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  .facts dt { font-size: 12px; color: var(--muted); }
  .facts dd { margin: 2px 0 0; font-weight: 700; }
  h2 { font-size: 18px; color: var(--brand); margin: 28px 0 8px; }
  .desc { white-space: pre-line; margin: 0; }
  .amen { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 0; }
  .amen li { font-size: 13px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: #fff; }
  .meta { font-size: 13px; color: var(--muted); margin-top: 24px; }
  .cta { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: rgba(252, 251, 247, .96); border-top: 1px solid var(--line); display: flex; justify-content: center; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: min(100%, 520px); height: 50px; border-radius: 999px; background: var(--brand); color: #fcfbf7; font-weight: 700; text-decoration: none; border: 1px solid var(--brass); font-size: 16px; }
  .more { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .more a { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; text-decoration: none; background: #fff; }
  .more b { font-weight: 600; }
  .more span { color: var(--brand); font-weight: 700; white-space: nowrap; }
  .gone { text-align: center; padding: 60px 0 20px; }
  .gone p { color: var(--muted); }
  .gone .btn { width: auto; padding: 0 28px; margin-top: 10px; }
`;

function shell({ title, description, url, image, canonical, jsonLd, body, robots = "index,follow", site }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta name="theme-color" content="#11352b">
<meta property="og:site_name" content="Property Stalkers">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${url ? `<meta property="og:url" content="${esc(url)}">` : ""}
<meta property="og:image" content="${esc(image || site + "/og.png")}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image || site + "/og.png")}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 27'%3E%3Cpath d='M12 26s-9-9.2-9-15.6a9 9 0 0 1 18 0C21 16.8 12 26 12 26z' fill='%23d4af37'/%3E%3Cpath d='M5.6 10.4Q12 4.4 18.4 10.4Q12 16.4 5.6 10.4Z' fill='%2311352b'/%3E%3Ccircle cx='12' cy='10.4' r='2.6' fill='%23d4af37'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
<style>${STYLE}</style>
</head>
<body>
<header><a href="/">${LOGO}<span>Property Stalkers</span></a></header>
${body}
</body>
</html>`;
}

function moreList(p, all, site) {
  const near = all
    .filter((x) => x.id !== p.id && x.city && p.city && x.city.toLowerCase() === p.city.toLowerCase())
    .sort((a, b) => (a.locality === p.locality ? 0 : 1) - (b.locality === p.locality ? 0 : 1) || String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 6);
  if (!near.length) return "";
  return `<h2>More in ${esc(p.city)}</h2><ul class="more">${near.map((x) =>
    `<li><a href="${site}/property/${x.id}"><b>${esc(titleOf(x))}${placeOf(x) ? `, ${esc(placeOf(x))}` : ""}</b><span>${esc(priceOf(x))}</span></a></li>`).join("")}</ul>`;
}

export function propertyPage(raw, { site, all = [], canonicalId = null, supabaseUrl = "" }) {
  const p = toPublic(raw, null);
  // Photos go through propertystalkers.com/sb/, like on the map, so they load where supabase.co is blocked.
  if (supabaseUrl) p.photos = p.photos.map((u) => (typeof u === "string" && u.startsWith(supabaseUrl + "/storage/") ? site + "/sb" + u.slice(supabaseUrl.length) : u));
  p.price_changed_at = raw.price_changed_at; p.confirmed_at = raw.confirmed_at;
  const url = `${site}/property/${p.id}`;
  const title = `${titleOf(p)}${placeOf(p) ? " in " + placeOf(p) : ""} · ${priceOf(p)} | Property Stalkers`;
  const description = summary(p);
  const photos = (p.photos || []).filter((u) => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 10);
  const facts = [];
  const add = (k, v) => { if (v !== "" && v != null) facts.push([k, v]); };
  if (p.deal === "share") {
    add("Room", ROOM[p.room_type] || "Room");
    add("Suits", SUITS[p.suits] || "");
    add("Bills", p.bills_included === true ? "Included" : p.bills_included === false ? "Extra" : "");
    add("Move in", p.move_in || "");
  } else if (p.deal === "stay") {
    add("Type", cap(TYPE[p.property_type] || "") || "");
    add("Bedrooms", p.bedrooms ? (p.bedrooms === 1 ? "1 bedroom" : `${p.bedrooms} bedrooms`) : "");
    add("Sleeps", p.guests ? `${p.guests} guests` : "");
    add("Minimum stay", p.min_nights ? (p.min_nights === 1 ? "1 night" : `${p.min_nights} nights`) : "");
  } else {
    add("Type", cap(TYPE[p.property_type] || "") || "");
    add("Bedrooms", p.bedrooms ? (p.bedrooms === 1 ? "1 bedroom" : `${p.bedrooms} bedrooms`) : "");
  }
  add("Size", p.size_sqft ? `${Number(p.size_sqft).toLocaleString("en-US")} sq ft` : "");
  if (isDev(p)) {
    add("Developer", p.company || "");
    add("Handover", p.possession || "");
    add("Unit types", Array.isArray(p.configs) && p.configs.length ? p.configs.map((c) => (Number(c) ? `${c} BHK` : c)).join(", ") : "");
  }
  add("Listed by", postedBy(p));
  const changed = lastChange(p);
  const deal = p.deal === "share" ? "Co-living" : p.deal === "stay" ? "Holiday home" : isDev(p) ? "New project" : p.deal === "rent" ? "For rent" : "For sale";
  const body = `<main>
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Map</a>${p.country ? ` › ${esc(p.country)}` : ""}${p.city ? ` › ${esc(p.city)}` : ""}${p.locality ? ` › ${esc(p.locality)}` : ""}</nav>
  ${photos.length ? `<div class="photos">${photos.map((u, i) => `<img src="${esc(u)}" alt="${esc(titleOf(p))}, photo ${i + 1}" loading="${i ? "lazy" : "eager"}" width="560" height="420">`).join("")}</div>` : `<div class="nophoto">${LOGO.replace('width="24" height="27"', 'width="56" height="63"')}</div>`}
  <h1>${esc(titleOf(p))}</h1>
  <p class="place">${esc(fullPlace(p))}</p>
  <p class="price">${esc(priceOf(p))}</p>
  <span class="tag">${deal}</span>${p.source === "dld" ? `<span class="tag">From Dubai Land Department project records</span>` : ""}
  <dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
  ${p.description ? `<h2>About this ${p.deal === "share" ? "room" : p.deal === "stay" ? "stay" : isDev(p) ? "project" : "property"}</h2><p class="desc">${esc(p.description)}</p>` : ""}
  ${p.deal === "share" && p.interests && p.interests.length ? `<h2>The household</h2><ul class="amen">${p.interests.map((a) => `<li>${esc(INTEREST_LABEL[a] || a)}</li>`).join("")}</ul>` : ""}
  ${p.amenities && p.amenities.length ? `<h2>Amenities</h2><ul class="amen">${p.amenities.map((a) => `<li>${esc(AMENITIES[a] || a)}</li>`).join("")}</ul>` : ""}
  <p class="meta">Listed on ${esc(longDay(p.created_at))}${changed && day(changed.toISOString()) !== day(p.created_at) ? ` · last updated ${esc(longDay(changed.toISOString()))}` : ""}. Prices are asking prices set by the lister.</p>
  ${moreList(p, all, site)}
</main>
<div class="cta"><a class="btn" href="/#p=${esc(p.id)}">See it on the map and contact the lister</a></div>`;
  return shell({ title, description, url, image: photos[0], canonical: `${site}/property/${canonicalId || p.id}`, jsonLd: structuredData(p, url), body, site });
}

export function gonePage({ site, post = null, all = [] }) {
  const where = post ? [post.locality, post.city].filter(Boolean).join(", ") : "";
  const body = `<main><div class="gone">
  <h1>This property is no longer listed</h1>
  <p>It may have been sold, rented or taken down by the lister.${where ? ` Here's what else is available in ${esc(where)}.` : ""}</p>
  <a class="btn" href="/">Browse the map</a></div>
  ${post ? moreList({ ...post, id: "" }, all, site) : ""}</main>`;
  return shell({ title: "No longer listed | Property Stalkers", description: "This property is no longer listed on Property Stalkers.", body, robots: "noindex,follow", site });
}

export function sitemap(listings, site) {
  const urls = [`  <url><loc>${site}/</loc><changefreq>daily</changefreq></url>`];
  for (const p of listings) {
    const d = lastChange(p);
    urls.push(`  <url><loc>${site}/property/${p.id}</loc>${d ? `<lastmod>${d.toISOString().slice(0, 10)}</lastmod>` : ""}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

const html = (body, status = 200) => new Response(body, { status, headers: {
  "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });

/** Handles /property/<id> and /sitemap.xml. Returns null for anything else. */
export async function handlePublic(req, { store, env }) {
  const url = new URL(req.url);
  const site = (env.SITE_URL || url.origin).replace(/\/+$/, "");
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  if (url.pathname === "/sitemap.xml") {
    const all = publicListings(await store.sitemapRows());
    return new Response(sitemap(all, site), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=1800" } });
  }

  const m = url.pathname.match(/^\/property\/([^/]+)\/?$/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (!UUID.test(id)) return html(gonePage({ site, all: [] }), 404);
  const post = await store.getPost(id);
  if (!post || post.kind !== "listing" || post.status === "draft" || post.lat == null) return html(gonePage({ site }), 404);
  // "More in <city>": listings near this one only, never the whole table.
  const all = publicListings(await store.mapPins({ w: post.lng - 0.3, e: post.lng + 0.3, s: post.lat - 0.3, n: post.lat + 0.3, kind: "listing", lim: 200 }));
  if (post.status !== "active") return html(gonePage({ site, post, all }), 410);
  // Several people can list the same unit; the map shows the cheapest, so that page is the main one.
  let canonicalId = null;
  if (post.unit_key) {
    const main = publicListings(await store.activeByUnitKey(post.unit_key))[0];
    if (main && main.id !== post.id) canonicalId = main.id;
  }
  return html(propertyPage(post, { site, all, canonicalId, supabaseUrl: env.SUPABASE_URL || "" }));
}
