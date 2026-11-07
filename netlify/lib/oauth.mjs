// Sign-in for the Claude connector (OAuth 2.1 with PKCE), so Claude can act for a Property Stalkers member.
//
// How it fits together:
//   1. Claude registers itself (POST /api/oauth/register), or identifies itself with a client metadata URL.
//   2. The member is sent to /authorize (public/authorize.html), signs in to Property Stalkers as usual, and taps Allow.
//      The page calls POST /api/oauth/approve with the member's normal sign-in token and gets back Claude's address
//      with a one-time code.
//   3. Claude swaps the code for an access token (1 hour) and a refresh token (60 days) at POST /api/oauth/token.
//   4. Claude sends the access token to /mcp; verifyAccessToken() turns it back into the member.
//
// Safety:
//   - PKCE (S256) is required; codes work once and only for 5 minutes.
//   - Only SHA-256 hashes of codes and tokens are stored.
//   - Refresh tokens are replaced on every use. If a replaced one comes back later (after a 30 second grace for retries),
//     the whole connection is switched off, because someone may have copied it.
//   - Codes are only ever sent to Claude's own addresses (or this computer, for testing), never to other sites.

export const SCOPE = "listings";
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 60 * 24 * 3600;
export const CODE_TTL_S = 300;
const RETRY_GRACE_MS = 30_000;

/** Where Claude sends people back after they tap Allow (any page on these hosts, so a new callback path keeps working). */
export const CLAUDE_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const CLAUDE_HOSTS = ["claude.ai", "claude.com"];
/** Hosts allowed to identify a client by a metadata document URL (Claude's published identity). */
const CIMD_HOSTS = ["claude.ai", "claude.com", "anthropic.com", "www.anthropic.com"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/* ---------------- small helpers ---------------- */

const enc = new TextEncoder();
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function randomToken(prefix, bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return prefix + b64url(a);
}
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
/** What we store instead of a code or token. */
export async function hashSecret(text) {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** PKCE S256: BASE64URL(SHA256(verifier)). */
export async function pkceChallenge(verifier) {
  return b64url(await sha256(verifier));
}
const nowIso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const isPast = (iso) => !iso || Date.parse(iso) <= Date.now();
const str = (v, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const tidyName = (v) => str(v, 200).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 80);

export const mcpResource = (origin) => origin + "/mcp";
const sameResource = (a, origin) => {
  if (!a) return true;
  const want = mcpResource(origin);
  return a.replace(/\/+$/, "") === want || a.replace(/\/+$/, "") === origin;
};

/** The two discovery documents (also served as static files from /.well-known/). */
export function serverMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/authorize",
    token_endpoint: origin + "/api/oauth/token",
    registration_endpoint: origin + "/api/oauth/register",
    revocation_endpoint: origin + "/api/oauth/revoke",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: origin + "/connector"
  };
}
export function resourceMetadata(origin) {
  return {
    resource: mcpResource(origin),
    resource_name: "Property Stalkers",
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: origin + "/connector"
  };
}

/** May a code be sent to this address? Claude's callback, a listed extra, or this computer (for testing). */
export function redirectAllowed(uri, env = {}) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  const extra = String(env.MCP_REDIRECTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (u.protocol === "https:" && !u.port && CLAUDE_HOSTS.includes(u.hostname)) return true;
  if (u.protocol === "https:" && extra.includes(uri)) return true;
  if (env.MCP_ALLOW_LOCALHOST !== "0" && (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.includes(u.hostname)) return true;
  return false;
}
const isClaudeRedirect = (uri) => { try { const u = new URL(uri); return u.protocol === "https:" && !u.port && CLAUDE_HOSTS.includes(u.hostname); } catch { return false; } };
const isLocalRedirect = (uri) => { try { return LOCAL_HOSTS.includes(new URL(uri).hostname); } catch { return false; } };

/* ---------------- clients ---------------- */

const cimdCache = new Map(); // url -> { doc, until }

/** A registered client, or one identified by a metadata document URL. null if unknown. */
export async function getClient(store, clientId, deps = {}) {
  const id = str(clientId, 500);
  if (!id) return null;
  if (/^https:\/\//i.test(id)) return fetchClientDocument(id, deps);
  if (!/^psc_[A-Za-z0-9_-]{10,80}$/.test(id)) return null;
  const [row] = await store.rows("mcp_clients", { client_id: id }, { limit: 1 });
  if (!row) return null;
  return { client_id: row.client_id, client_name: row.client_name || "An app", redirect_uris: Array.isArray(row.redirect_uris) ? row.redirect_uris : [], kind: "registered" };
}

async function fetchClientDocument(id, deps) {
  let u;
  try { u = new URL(id); } catch { return null; }
  const env = deps.env || {};
  const hosts = [...CIMD_HOSTS, ...String(env.MCP_CLIENT_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  if (u.protocol !== "https:" || !hosts.includes(u.hostname.toLowerCase()) || u.hash) return null;
  const hit = cimdCache.get(id);
  if (hit && hit.until > Date.now()) return hit.doc;
  const doFetch = deps.fetch || fetch;
  let doc = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await doFetch(id, { headers: { accept: "application/json" }, signal: ctl.signal, redirect: "error" });
    clearTimeout(timer);
    if (res.ok) {
      const text = await res.text();
      if (text.length < 20000) {
        const j = JSON.parse(text);
        const uris = Array.isArray(j.redirect_uris) ? j.redirect_uris.filter((x) => typeof x === "string").slice(0, 10) : [];
        if (j.client_id === id && uris.length) doc = { client_id: id, client_name: tidyName(j.client_name) || u.hostname, redirect_uris: uris, kind: "document" };
      }
    }
  } catch (e) { doc = null; }
  if (cimdCache.size > 50) cimdCache.clear();
  cimdCache.set(id, { doc, until: Date.now() + (doc ? 3600_000 : 60_000) });
  return doc;
}

/** Client + redirect address both check out? Returns { client } or { error }. */
async function checkClient(store, clientId, redirectUri, deps) {
  const client = await getClient(store, clientId, deps);
  if (!client) return { error: "invalid_client", text: "This app isn't registered with Property Stalkers." };
  const ru = str(redirectUri, 2000);
  if (!ru || !client.redirect_uris.includes(ru) || !redirectAllowed(ru, deps.env)) {
    return { error: "invalid_redirect_uri", text: "This sign-in link points somewhere we don't send codes to." };
  }
  return { client, redirect_uri: ru };
}

/* ---------------- tokens ---------------- */

async function issueTokens(store, { family, client_id, user_id, email, scope, resource }) {
  const access = randomToken("psk_at_");
  const refresh = randomToken("psk_rt_");
  const base = { family, client_id, user_id, email: email || null, scope: scope || SCOPE, resource: resource || null };
  await store.insert("mcp_tokens", [
    { ...base, token_hash: await hashSecret(access), kind: "access", expires_at: nowIso(ACCESS_TTL_S * 1000) },
    { ...base, token_hash: await hashSecret(refresh), kind: "refresh", expires_at: nowIso(REFRESH_TTL_S * 1000) }
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: base.scope };
}

async function killFamily(store, family) {
  await store.update("mcp_tokens", { family, revoked_at: null }, { revoked_at: nowIso() });
}

const verifyCache = new Map(); // hash -> { user, until }
/** The member behind a connector access token, or null if it's unknown, expired or switched off. */
export async function verifyAccessToken(store, token, origin) {
  if (typeof token !== "string" || !token.startsWith("psk_at_") || token.length > 200) return null;
  const h = await hashSecret(token);
  const hit = verifyCache.get(h);
  if (hit && hit.until > Date.now()) return hit.user;
  const [row] = await store.rows("mcp_tokens", { token_hash: h, kind: "access" }, { limit: 1 });
  if (!row || row.revoked_at || isPast(row.expires_at) || !sameResource(row.resource, origin)) { verifyCache.delete(h); return null; }
  const user = { id: row.user_id, email: row.email || null, phone: null, client_id: row.client_id, scope: row.scope };
  if (verifyCache.size > 500) verifyCache.clear();
  // Remember for a few seconds only, so switching a connection off takes effect almost at once.
  verifyCache.set(h, { user, until: Math.min(Date.now() + 10_000, Date.parse(row.expires_at)) });
  return user;
}
export function forgetVerified() { verifyCache.clear(); }

/* ---------------- tidy-up and rate limits ---------------- */

let lastSweep = 0;
async function sweep(store) {
  if (Date.now() - lastSweep < 3600_000) return;
  lastSweep = Date.now();
  const dayAgo = nowIso(-24 * 3600 * 1000);
  await Promise.all([
    store.remove("mcp_codes", { expires_at: { lt: dayAgo } }),
    store.remove("mcp_tokens", { expires_at: { lt: dayAgo } }),
    store.remove("mcp_usage", { window_start: { lt: nowIso(-2 * 24 * 3600 * 1000) } })
  ]).catch((e) => console.error("connector tidy-up failed", e.message));
}

/** One more call for key in this hour; true while under the limit. Never blocks callers if counting fails. */
export async function underLimit(store, key, limit) {
  if (!store.bumpCounter) return true;
  const hour = new Date(); hour.setUTCMinutes(0, 0, 0);
  try { return (await store.bumpCounter(key, hour.toISOString())) <= limit; }
  catch (e) { console.error("rate count failed", e.message); return true; }
}
export const clientIp = (req) => (req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown").slice(0, 60);

/* ---------------- HTTP routes under /api/oauth/ ---------------- */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400"
};
function reply(body, status = 200, { cors = false, extra = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...(cors ? CORS : {}), ...extra }
  });
}
const oauthError = (error, description, status = 400, cors = true) => reply({ error, error_description: description }, status, { cors });

async function readBody(req) {
  const type = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(await req.text()));
    if (type.includes("application/json")) { const j = await req.json(); return j && typeof j === "object" ? j : {}; }
    const text = await req.text();
    if (text.trim().startsWith("{")) return JSON.parse(text);
    return Object.fromEntries(new URLSearchParams(text));
  } catch { return {}; }
}

/** Add query parameters to a redirect address, keeping any it already has. */
function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

/**
 * Routes: GET metadata | resource | client, POST register | approve | token | revoke, GET/POST grants.
 * c: { path, method, req, url, user (a normal site sign-in, or null), deps }
 */
export async function oauthRoutes(c) {
  const { path, method, req, url, deps } = c;
  const { store, env = {} } = deps;
  const origin = url.origin;
  const sub = path.replace(/^\/oauth/, "");
  const publicRoutes = ["/metadata", "/resource", "/register", "/token", "/revoke"];

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: publicRoutes.includes(sub) ? CORS : {} });

  if (sub === "/metadata" && method === "GET") return reply(serverMetadata(origin), 200, { cors: true });
  if (sub === "/resource" && method === "GET") return reply(resourceMetadata(origin), 200, { cors: true });

  /* ----- register a client (RFC 7591) ----- */
  if (sub === "/register" && method === "POST") {
    if (!(await underLimit(store, "reg:ip:" + clientIp(req), 30))) return oauthError("too_many_requests", "Too many registrations. Please try again later.", 429);
    const b = await readBody(req);
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((x) => typeof x === "string") : [];
    if (!uris.length || uris.length > 5) return oauthError("invalid_redirect_uri", "Give one to five redirect_uris.");
    const bad = uris.find((u) => !redirectAllowed(u, env));
    if (bad) return oauthError("invalid_redirect_uri", "Only Claude's sign-in callback (or this computer, for testing) can receive codes.");
    const grants = Array.isArray(b.grant_types) && b.grant_types.length ? b.grant_types : ["authorization_code", "refresh_token"];
    if (grants.some((g) => !["authorization_code", "refresh_token"].includes(g))) return oauthError("invalid_client_metadata", "Only authorization_code and refresh_token are supported.");
    const responses = Array.isArray(b.response_types) && b.response_types.length ? b.response_types : ["code"];
    if (responses.some((r) => r !== "code")) return oauthError("invalid_client_metadata", "Only response_type code is supported.");
    const client = {
      client_id: randomToken("psc_", 18),
      client_name: tidyName(b.client_name) || "An app",
      redirect_uris: uris
    };
    await store.insert("mcp_clients", client);
    return reply({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.client_name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE
    }, 201, { cors: true });
  }

  /* ----- what the Allow page shows (no sign-in needed) ----- */
  if (sub === "/client" && method === "GET") {
    const r = await checkClient(store, url.searchParams.get("client_id"), url.searchParams.get("redirect_uri"), deps);
    if (r.error) return reply({ error: r.error, error_description: r.text }, 400);
    return reply({
      client_name: r.client.client_name,
      redirect_host: new URL(r.redirect_uri).host,
      is_claude: isClaudeRedirect(r.redirect_uri),
      is_local: isLocalRedirect(r.redirect_uri)
    });
  }

  /* ----- the member tapped Allow or Cancel ----- */
  if (sub === "/approve" && method === "POST") {
    if (!c.user) return reply({ error: "sign_in_required" }, 401);
    const b = await readBody(req);
    const r = await checkClient(store, b.client_id, b.redirect_uri, deps);
    if (r.error) return reply({ error: r.error, error_description: r.text }, 400);
    const state = str(b.state, 1000) || undefined;
    const back = (params) => reply({ redirect: withParams(r.redirect_uri, { ...params, state, iss: origin }) });
    if (b.decision !== "allow") return back({ error: "access_denied", error_description: "The member cancelled." });
    if (b.response_type && b.response_type !== "code") return back({ error: "unsupported_response_type" });
    if (b.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(str(b.code_challenge, 200))) {
      return back({ error: "invalid_request", error_description: "PKCE with S256 is required." });
    }
    const resource = str(b.resource, 500) || null;
    if (resource && !sameResource(resource, origin)) return back({ error: "invalid_target", error_description: "Unknown resource." });
    const code = randomToken("psk_c_");
    await store.insert("mcp_codes", {
      code_hash: await hashSecret(code),
      client_id: r.client.client_id,
      user_id: c.user.id,
      email: c.user.email || null,
      redirect_uri: r.redirect_uri,
      code_challenge: b.code_challenge,
      scope: SCOPE,
      resource: resource || mcpResource(origin),
      expires_at: nowIso(CODE_TTL_S * 1000)
    });
    if (r.client.kind === "registered") await store.update("mcp_clients", { client_id: r.client.client_id }, { last_used_at: nowIso() }).catch(() => {});
    await sweep(store);
    return back({ code });
  }

  /* ----- swap a code or a refresh token for tokens ----- */
  if (sub === "/token" && method === "POST") {
    if (!(await underLimit(store, "tok:ip:" + clientIp(req), 300))) return oauthError("too_many_requests", "Too many requests. Please try again later.", 429);
    const b = await readBody(req);
    const grant = str(b.grant_type, 50);

    if (grant === "authorization_code") {
      const code = str(b.code, 200), verifier = str(b.code_verifier, 200);
      if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier are required.");
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_grant", "The code_verifier isn't valid.");
      const h = await hashSecret(code);
      const [row] = await store.rows("mcp_codes", { code_hash: h }, { limit: 1 });
      if (!row) return oauthError("invalid_grant", "That code isn't valid.");
      if (row.used_at) {
        // A code used twice: someone may have intercepted it. Switch off anything it produced.
        await killFamily(store, h);
        return oauthError("invalid_grant", "That code was already used.");
      }
      if (isPast(row.expires_at)) return oauthError("invalid_grant", "That code has expired. Please connect again.");
      if (row.client_id !== str(b.client_id, 500)) return oauthError("invalid_grant", "That code belongs to another app.");
      if (b.redirect_uri !== undefined && row.redirect_uri !== str(b.redirect_uri, 2000)) return oauthError("invalid_grant", "redirect_uri doesn't match.");
      if ((await pkceChallenge(verifier)) !== row.code_challenge) return oauthError("invalid_grant", "PKCE check failed.");
      if (b.resource && !sameResource(str(b.resource, 500), origin)) return oauthError("invalid_target", "Unknown resource.");
      // Claim the code; only one request can win.
      const claimed = await store.update("mcp_codes", { code_hash: h, used_at: null }, { used_at: nowIso() });
      if (!claimed.length) return oauthError("invalid_grant", "That code was already used.");
      const tokens = await issueTokens(store, { family: h, client_id: row.client_id, user_id: row.user_id, email: row.email, scope: row.scope, resource: row.resource });
      return reply(tokens, 200, { cors: true });
    }

    if (grant === "refresh_token") {
      const rt = str(b.refresh_token, 200);
      if (!rt.startsWith("psk_rt_")) return oauthError("invalid_grant", "That refresh token isn't valid.");
      const h = await hashSecret(rt);
      const [row] = await store.rows("mcp_tokens", { token_hash: h, kind: "refresh" }, { limit: 1 });
      if (!row || row.revoked_at || isPast(row.expires_at)) return oauthError("invalid_grant", "Please connect again.");
      if (b.client_id && row.client_id !== str(b.client_id, 500)) return oauthError("invalid_grant", "That token belongs to another app.");
      if (row.rotated_at) {
        // Already replaced. A quick retry (lost reply) is fine; a late reuse means it may have been copied.
        if (Date.now() - Date.parse(row.rotated_at) > RETRY_GRACE_MS) {
          await killFamily(store, row.family);
          return oauthError("invalid_grant", "Please connect again.");
        }
      } else {
        const claimed = await store.update("mcp_tokens", { token_hash: h, rotated_at: null }, { rotated_at: nowIso() });
        if (!claimed.length) {
          const [again] = await store.rows("mcp_tokens", { token_hash: h }, { limit: 1 });
          if (!again || again.revoked_at || !again.rotated_at || Date.now() - Date.parse(again.rotated_at) > RETRY_GRACE_MS) {
            return oauthError("invalid_grant", "Please connect again.");
          }
        }
      }
      const tokens = await issueTokens(store, { family: row.family, client_id: row.client_id, user_id: row.user_id, email: row.email, scope: row.scope, resource: row.resource });
      return reply(tokens, 200, { cors: true });
    }

    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  /* ----- an app gives back a token (RFC 7009): switch off its whole connection ----- */
  if (sub === "/revoke" && method === "POST") {
    const b = await readBody(req);
    const t = str(b.token, 200);
    if (t.startsWith("psk_at_") || t.startsWith("psk_rt_")) {
      const [row] = await store.rows("mcp_tokens", { token_hash: await hashSecret(t) }, { limit: 1 });
      if (row) { await killFamily(store, row.family); forgetVerified(); }
    }
    return new Response(null, { status: 200, headers: CORS });
  }

  /* ----- the member's connected apps (shown on the Allow page) ----- */
  if (sub === "/grants") {
    if (!c.user) return reply({ error: "sign_in_required" }, 401);
    if (method === "GET") {
      const rows = await store.rows("mcp_tokens", { user_id: c.user.id, kind: "refresh", revoked_at: null }, { limit: 500 });
      const live = rows.filter((r) => !r.rotated_at && !isPast(r.expires_at));
      const byFamily = new Map();
      for (const r of live) {
        const g = byFamily.get(r.family) || { id: r.family, client_id: r.client_id, last_used: r.created_at };
        if (r.created_at > g.last_used) g.last_used = r.created_at;
        byFamily.set(r.family, g);
      }
      const out = [];
      for (const g of byFamily.values()) {
        const client = await getClient(store, g.client_id, deps).catch(() => null);
        out.push({ id: g.id, name: client ? client.client_name : "An app", last_used: g.last_used });
      }
      out.sort((a, b) => String(b.last_used).localeCompare(String(a.last_used)));
      return reply({ grants: out });
    }
    if (method === "POST") {
      const b = await readBody(req);
      const where = { user_id: c.user.id, revoked_at: null };
      if (b.all !== true) {
        const id = str(b.id, 100);
        if (!/^[0-9a-f]{64}$/.test(id)) return reply({ error: "Not found" }, 404);
        where.family = id;
      }
      await store.update("mcp_tokens", where, { revoked_at: nowIso() });
      forgetVerified();
      return reply({ ok: true });
    }
  }

  return null;
}
