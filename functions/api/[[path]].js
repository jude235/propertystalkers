// Cloudflare Pages Function serving every /api/* request.
import { serve } from "../../netlify/lib/server.mjs";

// Signed-out map requests are the same for everyone, so busy areas are answered from Cloudflare's cache
// for 30 seconds. Signed-in requests are personal (hidden listings, shortlist), so they are never cached.
const CACHE_SECONDS = 30;

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const cacheable = request.method === "GET" && url.pathname === "/api/map" && !request.headers.get("authorization")
    && typeof caches !== "undefined" && caches.default;
  if (cacheable) {
    const hit = await caches.default.match(request);
    if (hit) return hit;
  }
  const res = await serve(request, context.env, context);
  if (cacheable && res.status === 200) {
    const out = new Response(res.body, res);
    out.headers.set("cache-control", `public, max-age=${CACHE_SECONDS}`);
    context.waitUntil(caches.default.put(request, out.clone()));
    return out;
  }
  return res;
}
