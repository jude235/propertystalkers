// Netlify Function serving every /api/* request.
import { handle } from "../lib/handler.mjs";
import { makeStore } from "../lib/db.mjs";
import { makeAI } from "../lib/ai.mjs";
import { makeGeo } from "../lib/geo.mjs";

const env = process.env;
let deps;

function getDeps() {
  if (!deps) {
    deps = {
      env,
      store: makeStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }),
      ai: makeAI({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL || "claude-haiku-5-5" }),
      geo: makeGeo({ apiKey: env.GOOGLE_GEOCODING_KEY })
    };
  }
  return deps;
}

export default async (req) => {
  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
    "GOOGLE_MAPS_BROWSER_KEY", "GOOGLE_GEOCODING_KEY"].filter((k) => !env[k]);
  if (missing.length) {
    return new Response(JSON.stringify({ error: "not_configured", missing }), {
      status: 503, headers: { "content-type": "application/json" }
    });
  }
  return handle(req, getDeps());
};

export const config = { path: "/api/*" };
