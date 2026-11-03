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
  for (const k of ["getUser", "getProfile", "rows", "getPost", "postsFull", "mapPins", "avatarsFor"]) {
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

test("full details for many listings in one request: same as opening each, private bits stay private, few database waits", async () => {
  const { store, log } = slowStore(40);
  const owner = store.addUser("own2@x.in");
  await store.upsertProfile({ id: owner.id, email: "own2@x.in", name: "Own", avatar_url: "https://x/a.jpg" });
  const me = store.addUser("me2@x.in");
  await store.upsertProfile({ id: me.id, email: "me2@x.in", name: "Me" });
  const mk = (o) => store.createPost({ user_id: owner.id, kind: "listing", poster_type: "landlord", deal: "sale", property_type: "apartment", price: 1000000, currency: "AED", city: "Dubai", lat: 25.08, lng: 55.14, status: "active", photos: ["https://x/1.jpg"], description: "Sea view", contact_name: "Own", contact_phone: "971500000001", unit_number: "1203", ...o });
  const a = await mk({}), b = await mk({ price: 1200000, lat: 24.47, lng: 54.6, city: "Abu Dhabi", deal: "rent" }), gone = await mk({ status: "removed" });
  await store.insert("watches", [{ user_id: me.id, post_id: b.id }]);
  const deps = { store, ai: scriptedAI(), geo: tableGeo({}), env: ENV };
  log.length = 0;
  const r = await handle(req("POST", "/posts/details", { token: me.token, body: { ids: [b.id, a.id, gone.id, "not-an-id"] } }), deps);
  const { posts } = await r.json();
  assert.deepEqual(posts.map((p) => p.id), [b.id, a.id], "in the order asked, without listings that are gone");
  assert.equal(posts[1].description, "Sea view");
  assert.equal(posts[1].contact_phone, "971500000001");
  assert.equal(posts[1].contact_avatar, "https://x/a.jpg");
  assert.equal(posts[1].unit_number, null, "unit number is private");
  assert.deepEqual([posts[0].watched, posts[1].watched], [true, false]);
  assert.ok(waves(log, 25) <= 3, `waves: ${waves(log, 25)} ${JSON.stringify(log.map((x) => x.k))}`);
  // Same as asking for one listing on its own
  const single = (await (await handle(req("GET", "/posts/" + a.id, { token: me.token }), deps)).json()).post;
  assert.deepEqual(posts[1], single);
});

test("full details: at most 40 listings per request, and an empty list is fine", async () => {
  const store = memoryStore();
  const u = store.addUser("o3@x.in");
  const ids = [];
  for (let i = 0; i < 45; i++) ids.push((await store.createPost({ user_id: u.id, kind: "listing", poster_type: "landlord", deal: "sale", property_type: "apartment", price: 100 + i, currency: "AED", city: "Dubai", lat: 25, lng: 55, status: "active", photos: [] })).id);
  const deps = { store, ai: scriptedAI(), geo: tableGeo({}), env: ENV };
  const r = await (await handle(req("POST", "/posts/details", { body: { ids } }), deps)).json();
  assert.equal(r.posts.length, 40);
  assert.deepEqual(await (await handle(req("POST", "/posts/details", { body: {} }), deps)).json(), { posts: [] });
});
