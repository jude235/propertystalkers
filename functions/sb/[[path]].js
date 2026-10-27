// Cloudflare Pages Function: forwards sign-in and photo requests to Supabase through
// propertystalkers.com, so the site keeps working where *.supabase.co is blocked.
import { tidyEnv } from "../../netlify/lib/server.mjs";

const DROP = ["host", "cookie", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-proto", "x-real-ip", "x-forwarded-for"];

export async function onRequest({ request, env }) {
  const { SUPABASE_URL } = tidyEnv(env);
  if (!SUPABASE_URL) return new Response("Not configured", { status: 503 });
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/sb/, "");
  if (!/^\/(auth|storage)\/v1\//.test(rest)) return new Response("Not found", { status: 404 });

  const headers = new Headers(request.headers);
  DROP.forEach((h) => headers.delete(h));
  const init = { method: request.method, headers, redirect: "manual" };
  if (!["GET", "HEAD"].includes(request.method)) init.body = request.body;
  const res = await fetch(SUPABASE_URL + rest + url.search, init);

  const out = new Headers(res.headers);
  out.delete("set-cookie");
  // Public photos rarely change; let browsers and Cloudflare keep them.
  if (request.method === "GET" && rest.startsWith("/storage/v1/object/public/") && res.ok) {
    out.set("cache-control", "public, max-age=86400");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
