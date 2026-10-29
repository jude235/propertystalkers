// Shared server set-up used by both Netlify and Cloudflare.
import { handle } from "./handler.mjs";
import { makeStore } from "./db.mjs";
import { makeAI } from "./ai.mjs";
import { makeGeo } from "./geo.mjs";
import { makeMailer } from "./notify.mjs";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
  "GOOGLE_MAPS_BROWSER_KEY", "GOOGLE_GEOCODING_KEY"];

// Tidy pasted values: trim spaces and stray quote marks, and make sure the
// Supabase address is a full https:// URL without a trailing slash.
const tidy = (v) => (typeof v === "string" ? v : "").trim().replace(/^["']+|["']+$/g, "").trim();

export function tidyEnv(raw) {
  const env = {};
  for (const [k, v] of Object.entries(raw || {})) if (typeof v === "string") env[k] = tidy(v);
  if (env.SUPABASE_URL) {
    if (!/^https?:\/\//i.test(env.SUPABASE_URL)) env.SUPABASE_URL = "https://" + env.SUPABASE_URL;
    env.SUPABASE_URL = env.SUPABASE_URL.replace(/\/+$/, "");
  }
  return env;
}

let cached = null;
export async function serve(req, rawEnv, ctx = null) {
  const env = tidyEnv(rawEnv);
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    return new Response(JSON.stringify({ error: "not_configured", missing }), {
      status: 503, headers: { "content-type": "application/json" }
    });
  }
  const key = [...REQUIRED, "BREVO_API_KEY", "MAIL_FROM", "AI_MODEL"].map((k) => env[k] || "").join("|");
  if (!cached || cached.key !== key) {
    cached = { key, deps: {
      env,
      store: makeStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }),
      ai: makeAI({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL || "claude-haiku-5-5" }),
      geo: makeGeo({ apiKey: env.GOOGLE_GEOCODING_KEY }),
      mail: makeMailer({ apiKey: env.BREVO_API_KEY, from: env.MAIL_FROM || "alerts@propertystalkers.com", site: env.SITE_URL || "https://propertystalkers.com" })
    } };
  }
  // On Cloudflare, background work (alerts, emails, jobs) finishes after the reply is sent.
  const defer = ctx && typeof ctx.waitUntil === "function" ? (p) => ctx.waitUntil(p) : null;
  return handle(req, defer ? { ...cached.deps, defer } : cached.deps);
}
