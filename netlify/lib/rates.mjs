// Exchange rates, so a price can also be shown in the visitor's own currency. Looked up at most every 6 hours.
// Rates come from Frankfurter (frankfurter.dev: free, no key, blended central-bank rates). Gulf currencies that are
// fixed to the US dollar use their fixed rate when the lookup doesn't carry them.
export const PEGS = { AED: 3.6725, SAR: 3.75, QAR: 3.64, BHD: 0.376, OMR: 0.3845 };
const SOURCES = ["https://api.frankfurter.dev/v2/rates?base=USD", "https://api.frankfurter.dev/v1/latest?base=USD"];
const KEEP_MS = 6 * 3600 * 1000, RETRY_MS = 10 * 60 * 1000;
let memo = null;

/** Read either answer shape: a list of { quote, rate } rows, or { rates: { EUR: 0.9, … } }. */
export function readRates(j) {
  const out = {};
  const put = (k, v) => { const c = String(k || "").toUpperCase(), n = Number(v); if (/^[A-Z]{3}$/.test(c) && Number.isFinite(n) && n > 0) out[c] = n; };
  if (Array.isArray(j)) for (const r of j) { if (r && typeof r === "object") put(r.quote ?? r.currency ?? r.code, r.rate ?? r.value); }
  else if (j && typeof j === "object" && j.rates && typeof j.rates === "object") {
    if (Array.isArray(j.rates)) return readRates(j.rates);
    for (const [k, v] of Object.entries(j.rates)) put(k, v);
  }
  return out;
}

/** How many of each currency one US dollar buys. `live` is false when only the fixed rates are known. */
export async function usdRates(getJson, now = Date.now()) {
  if (memo && now < memo.until) return memo.v;
  let rates = {};
  for (const u of SOURCES) {
    try { rates = readRates(await getJson(u)); } catch (e) { rates = {}; }
    if (Object.keys(rates).length >= 10) break;
  }
  const live = Object.keys(rates).length >= 10;
  const v = { base: "USD", rates: { ...PEGS, ...(live ? rates : {}), USD: 1 }, live, at: new Date(now).toISOString() };
  memo = { until: now + (live ? KEEP_MS : RETRY_MS), v };
  return v;
}
export function forgetRates() { memo = null; }

const fetchJson = async (u) => {
  const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("rates " + r.status);
  return r.json();
};

export async function ratesRoute({ path, method, deps }) {
  if (path !== "/rates" || method !== "GET") return null;
  const v = await usdRates((deps && deps.ratesJson) || fetchJson);
  return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json", "cache-control": v.live ? "public, max-age=3600" : "no-store" } });
}
