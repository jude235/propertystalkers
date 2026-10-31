// Opening a listing must be quick: the database trips it needs run side by side, not one after another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { tokenExpiry } from "../netlify/lib/db.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

/** A store where every database call takes `ms`, recording how many waves of calls a request needed. */
function slowStore(ms) {
  const store = memoryStore();
  const log = [];
  for (const k of ["getUser", "getProfile", "rows", "getPost", "mapPins", "avatarsFor"]) {
    const f = store[k].bind(store);
    store[k] = async (...a) => {
      if (k === "getUser" && !a[0]) return null;   // no token: the real store doesn't ask the auth server
      const at = Date.now(); await new Promise((r) => setTimeout(r, ms)); log.push({ k, at }); return f(...a); };
  }
  return { store, log };
}
/** Calls that started within `gap` ms of each other count as one wave (one trip's worth of waiting). */
const waves = (log, gap) => { const t = log.map((x) => x.at).sort((a, b) => a - b); let n = 0, last = -1e9; for (const x of t) { if (x - last > gap) n++; last = x; } return n; };

test("opening a listing, signed in: at most 3 database waits (sign-in, then who + listing, then the rest)", async () => {
  const { store, log } = slowStore(60);
  const u = store.addUser("me@x.in");
  await store.upsertProfile({ id: u.id, email: "me@x.in", name: "Me" });
  const p = await store.createPost({ user_id: u.id, kind: "listing", poster_type: "landlord", deal: "sale", property_type: "apartment", price: 100, currency: "AED", city: "Dubai", lat: 25.08, lng: 55.14, status: "active", photos: [] });
  log.length = 0;
  const t0 = Date.now();
  const r = await handle(req("GET", "/posts/" + p.id, { token: u.token }), { store, ai: scriptedAI(), geo: tableGeo({}), env: ENV });
  const took = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.equal((await r.json()).post.id, p.id);
  assert.ok(waves(log, 30) <= 3, `waves: ${waves(log, 30)} ${JSON.stringify(log.map((x) => x.k))}`);
  assert.ok(took < 60 * 4, `took ${took} ms`);
});

test("opening a listing, signed out: 2 database waits", async () => {
  const { store, log } = slowStore(60);
  const u = store.addUser("o@x.in");
  const p = await store.createPost({ user_id: u.id, kind: "listing", poster_type: "landlord", deal: "rent", property_type: "apartment", price: 100, currency: "AED", city: "Dubai", lat: 25.08, lng: 55.14, status: "active", photos: [] });
  log.length = 0;
  const r = await handle(req("GET", "/posts/" + p.id), { store, ai: scriptedAI(), geo: tableGeo({}), env: ENV });
  assert.equal(r.status, 200);
  assert.ok(waves(log, 30) <= 2, `waves: ${waves(log, 30)} ${JSON.stringify(log.map((x) => x.k))}`);
});

test("sign-in token expiry is read from the token (so a remembered sign-in never outlives it)", () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  assert.equal(tokenExpiry(`${b64({ alg: "HS256" })}.${b64({ sub: "x", exp: 1800000000 })}.sig`), 1800000000 * 1000);
  assert.equal(tokenExpiry("not-a-token"), null);
  assert.equal(tokenExpiry(""), null);
});
