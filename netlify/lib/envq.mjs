// Area air and noise, shown as two small marks on each listing.
//   Air: Google's Air Quality API, turned into the familiar US-style AQI (0-500, lower is better) from PM2.5 and PM10 (dust).
//        One lookup per ~3 km square, refreshed once a day, capped per day so it stays inside Google's free monthly allowance.
//   Noise: an estimate from OpenStreetMap: how close the spot is to highways, main roads, rail / metro lines, airport runways
//        and nightlife. One lookup per ~200 m square, kept for 90 days. It's a guide, not a measurement.
// Everything is cached in the area_env table, so showing it costs one quick database read; lookups happen after the reply.

const AIR_CELL = 0.03, NOISE_CELL = 0.002;
const AIR_TTL = 24 * 3600e3, NOISE_TTL = 90 * 24 * 3600e3, FAIL_TTL = 6 * 3600e3;
export const AIR_DAILY_CAP = 300;
const PER_REQUEST = { air: 4, noise: 3 };

const cellOf = (v, size) => (Math.round(v / size) * size).toFixed(size < 0.01 ? 3 : 2);
export const airKey = (lat, lng) => `air:${cellOf(lat, AIR_CELL)},${cellOf(lng, AIR_CELL)}`;
export const noiseKey = (lat, lng) => `noise:${cellOf(lat, NOISE_CELL)},${cellOf(lng, NOISE_CELL)}`;
const centreOf = (key) => key.split(":")[1].split(",").map(Number);

/* ---------- air ---------- */
// US EPA breakpoints (2024): [concentration low, high, AQI low, high]
const PM25 = [[0, 9, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]];
const PM10 = [[0, 54, 0, 50], [55, 154, 51, 100], [155, 254, 101, 150], [255, 354, 151, 200], [355, 424, 201, 300], [425, 604, 301, 500]];
function subIndex(c, table) {
  if (c == null || !(c >= 0)) return null;
  const t = Math.floor(c * 10) / 10;
  for (const [cl, ch, il, ih] of table) if (t <= ch) return Math.round(((ih - il) / (ch - cl)) * (Math.max(t, cl) - cl) + il);
  return 500;
}
export function usAqi(pm25, pm10) {
  const a = subIndex(pm25, PM25), b = subIndex(pm10, PM10);
  return a == null && b == null ? null : Math.max(a ?? 0, b ?? 0);
}
export function airLevel(aqi) {
  if (aqi == null) return null;
  return aqi <= 50 ? { lvl: 1, label: "Good" } : aqi <= 100 ? { lvl: 2, label: "Moderate" } : aqi <= 150 ? { lvl: 3, label: "Unhealthy for sensitive groups" } : { lvl: 4, label: "Unhealthy" };
}

async function lookupAir(lat, lng, key, fetchImpl) {
  const res = await fetchImpl(`https://airquality.googleapis.com/v1/currentConditions:lookup?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { latitude: lat, longitude: lng }, universalAqi: false, extraComputations: ["POLLUTANT_CONCENTRATION"], languageCode: "en" })
  });
  if (!res.ok) throw new Error("air " + res.status);
  const d = await res.json();
  const conc = (code) => {
    const p = (d.pollutants || []).find((x) => x.code === code);
    return p && p.concentration ? Number(p.concentration.value) : null;
  };
  const pm25 = conc("pm25"), pm10 = conc("pm10");
  const aqi = usAqi(pm25, pm10);
  if (aqi == null) return null;
  const main = subIndex(pm10, PM10) > subIndex(pm25, PM25) ? "dust (PM10)" : "fine particles (PM2.5)";
  return { aqi, ...airLevel(aqi), main, at: d.dateTime || new Date().toISOString() };
}

/* ---------- noise ---------- */
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
function metres(lat1, lng1, lat2, lng2) {
  const x = rad(lng2 - lng1) * Math.cos(rad((lat1 + lat2) / 2)), y = rad(lat2 - lat1);
  return Math.sqrt(x * x + y * y) * R;
}
/** Shortest distance (m) from a point to a line drawn through points. */
export function distToLine(lat, lng, pts) {
  if (!pts || !pts.length) return Infinity;
  const kx = Math.cos(rad(lat)) * R * Math.PI / 180, ky = R * Math.PI / 180; // metres per degree
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] || pts[i];
    const ax = (a.lon - lng) * kx, ay = (a.lat - lat) * ky, bx = (b.lon - lng) * kx, by = (b.lat - lat) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const near = (m) => (m < 1000 ? `about ${Math.max(50, Math.round(m / 50) * 50)} m` : `about ${(m / 1000).toFixed(1)} km`);

/** Turn nearby map features into a noise level and plain-English reasons. */
export function scoreNoise(lat, lng, elements) {
  let pts = 0;
  const why = [];
  const best = {};
  for (const e of elements || []) {
    const t = e.tags || {};
    const d = e.type === "node" ? metres(lat, lng, e.lat, e.lon) : distToLine(lat, lng, e.geometry);
    const kind = t.aeroway === "runway" ? "runway"
      : /^(motorway|trunk)(_link)?$/.test(t.highway || "") ? "highway"
      : /^primary(_link)?$/.test(t.highway || "") ? "main"
      : /^(secondary|tertiary)$/.test(t.highway || "") ? "road"
      : /^(rail|subway|light_rail|tram)$/.test(t.railway || "") ? "rail"
      : /^(nightclub|bar|pub)$/.test(t.amenity || "") ? "night" : null;
    if (!kind) continue;
    if (kind === "night") { best.night = (best.night || 0) + (d <= 200 ? 1 : 0); continue; }
    if (!best[kind] || d < best[kind].d) best[kind] = { d, name: t.name || t.ref || null };
  }
  const add = (n, text) => { if (n > 0) { pts += n; why.push(text); } };
  if (best.highway) { const d = best.highway.d; add(d < 100 ? 45 : d < 200 ? 32 : d < 400 ? 18 : 0, `${near(d)} from ${best.highway.name || "a highway"}`); }
  if (best.main) { const d = best.main.d; add(d < 60 ? 28 : d < 150 ? 16 : d < 300 ? 7 : 0, `${near(d)} from ${best.main.name || "a main road"}`); }
  if (best.road) { const d = best.road.d; add(d < 40 ? 12 : d < 120 ? 6 : 0, `${near(d)} from ${best.road.name || "a busy street"}`); }
  if (best.rail) { const d = best.rail.d; add(d < 80 ? 20 : d < 250 ? 9 : 0, `${near(d)} from ${best.rail.name || "a rail or metro line"}`); }
  if (best.runway) { const d = best.runway.d; add(d < 2000 ? 35 : d < 4000 ? 18 : 0, `${near(d)} from an airport runway`); }
  if (best.night) add(Math.min(15, best.night * 5), `${best.night} bar${best.night > 1 ? "s or clubs" : " or club"} within 200 m`);
  const lvl = pts < 12 ? 1 : pts < 30 ? 2 : pts < 55 ? 3 : 4;
  return { score: Math.min(100, pts), lvl, label: ["", "Quiet", "Moderate", "Busy", "Noisy"][lvl], why: why.slice(0, 3) };
}

async function lookupNoise(lat, lng, fetchImpl) {
  const q = `[out:json][timeout:20];(
    way(around:400,${lat},${lng})[highway~"^(motorway|trunk|motorway_link|trunk_link|primary|primary_link)$"];
    way(around:120,${lat},${lng})[highway~"^(secondary|tertiary)$"];
    way(around:250,${lat},${lng})[railway~"^(rail|subway|light_rail|tram)$"];
    way(around:4000,${lat},${lng})[aeroway=runway];
    node(around:200,${lat},${lng})[amenity~"^(nightclub|bar|pub)$"];
  );out tags geom qt;`;
  const res = await fetchImpl("https://overpass-api.de/api/interpreter", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "PropertyStalkers/1.0 (+https://propertystalkers.com)" },
    body: "data=" + encodeURIComponent(q)
  });
  if (!res.ok) throw new Error("noise " + res.status);
  const d = await res.json();
  return scoreNoise(lat, lng, d.elements || []);
}

/* ---------- cache, attach, fill ---------- */
export function makeEnvq({ airKey: key, fetchImpl = fetch }) {
  return {
    air: key ? (lat, lng) => lookupAir(lat, lng, key, fetchImpl) : null,
    noise: (lat, lng) => lookupNoise(lat, lng, fetchImpl)
  };
}

const fresh = (row, ttl) => row && Date.now() - new Date(row.updated_at).getTime() < (row.data && row.data.failed ? FAIL_TTL : ttl);

/** Add { env: { air, noise } } to each pin from the cache; returns the area keys that need a (re)lookup. */
export async function attachEnv(store, pins) {
  const withPos = pins.filter((p) => p && p.lat != null && p.lng != null);
  if (!withPos.length || !store.rows) return [];
  const keys = [...new Set(withPos.flatMap((p) => [airKey(p.lat, p.lng), noiseKey(p.lat, p.lng)]))];
  let rows = [];
  try { rows = await store.rows("area_env", { key: { in: keys } }, { limit: 1000 }); } catch (e) { return []; }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const missing = new Set();
  for (const p of withPos) {
    const a = byKey.get(airKey(p.lat, p.lng)), n = byKey.get(noiseKey(p.lat, p.lng));
    const air = a && a.data && !a.data.failed ? a.data : null, noise = n && n.data && !n.data.failed ? n.data : null;
    if (air || noise) p.env = { air, noise };
    if (!fresh(a, AIR_TTL)) missing.add(airKey(p.lat, p.lng));
    if (!fresh(n, NOISE_TTL)) missing.add(noiseKey(p.lat, p.lng));
  }
  return [...missing];
}

async function save(store, key, data) {
  const row = { key, data, updated_at: new Date().toISOString() };
  const hit = await store.rows("area_env", { key });
  if (hit.length) await store.update("area_env", { key }, row); else await store.insert("area_env", [row]);
}

/** Look up a few missing areas (after the reply). Air lookups are capped per day. */
export async function fillEnv(store, envq, keys) {
  if (!envq || !keys || !keys.length) return 0;
  const today = "budget:" + new Date().toISOString().slice(0, 10);
  let done = 0;
  const air = keys.filter((k) => k.startsWith("air:")).slice(0, PER_REQUEST.air);
  const noise = keys.filter((k) => k.startsWith("noise:")).slice(0, PER_REQUEST.noise);
  if (air.length && envq.air) {
    const b = (await store.rows("area_env", { key: today }))[0];
    let used = (b && b.data && b.data.n) || 0;
    for (const k of air) {
      if (used >= AIR_DAILY_CAP) break;
      const [lat, lng] = centreOf(k);
      used++;
      try { const v = await envq.air(lat, lng); await save(store, k, v || { failed: true }); done++; }
      catch (e) { await save(store, k, { failed: true }).catch(() => {}); }
    }
    await save(store, today, { n: used });
  }
  for (const k of noise) {
    const [lat, lng] = centreOf(k);
    try { await save(store, k, await envq.noise(lat, lng)); done++; }
    catch (e) { await save(store, k, { failed: true }).catch(() => {}); }
  }
  return done;
}
