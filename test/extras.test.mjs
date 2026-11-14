// Price history, views, reporting a listing, extra details, and marking a listing sold or rented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { cleanExtras, cleanLink } from "../netlify/lib/extras.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

async function setup() {
  const store = memoryStore();
  const deps = { store, ai: scriptedAI(), geo: tableGeo({}), env: ENV };
  const call = async (...a) => { const r = await handle(req(...a), deps); return { status: r.status, body: await r.json() }; };
  const person = async (email) => { const u = store.addUser(email); await store.upsertProfile({ id: u.id, email, name: email.split("@")[0], phone: "971500000001" }); return u; };
  const owner = await person("own@x.in"), visitor = await person("vis@x.in"), admin = await person("admin@ps.in");
  const post = await store.createPost({ user_id: owner.id, kind: "listing", poster_type: "landlord", deal: "sale", property_type: "apartment", bedrooms: 2, price: 1000000, first_price: 1000000, currency: "AED",
    building: "Sky", locality: "Marina", city: "Dubai", country: "United Arab Emirates", lat: 25.08, lng: 55.14, precision: "building", status: "active", photos: [], contact_name: "own", contact_phone: "971500000001" });
  const details = async (token) => (await call("POST", "/posts/details", { token, body: { ids: [post.id] } })).body.posts[0];
  return { store, call, owner, visitor, admin, post, details };
}

test("extra details: checked, saved by the owner only, shown on the listing, cleared when emptied", async () => {
  const { call, owner, visitor, post, details } = await setup();
  assert.deepEqual((await details()).extra, {});
  const body = { permit_number: " 71234 56789 ", floor_level: "12", year_built: 2019, service_charge: "14.567", video_url: "youtube.com/watch?v=abc", tour_url: "" };
  assert.equal((await call("PATCH", `/posts/${post.id}/extras`, { body })).status, 401);
  assert.equal((await call("PATCH", `/posts/${post.id}/extras`, { token: visitor.token, body })).status, 403);
  const ok = await call("PATCH", `/posts/${post.id}/extras`, { token: owner.token, body });
  assert.equal(ok.status, 200);
  const want = { permit_number: "71234 56789", floor_level: 12, year_built: 2019, service_charge: 14.57, video_url: "https://youtube.com/watch?v=abc" };
  assert.deepEqual(ok.body.extra, want);
  assert.deepEqual((await details(visitor.token)).extra, want);
  assert.deepEqual((await call("PATCH", `/posts/${post.id}/extras`, { token: owner.token, body: { floor_level: "", video_url: null } })).body.extra, { permit_number: "71234 56789", year_built: 2019, service_charge: 14.57 });
  for (const bad of [{ floor_level: -1 }, { floor_level: 2.5 }, { year_built: 1500 }, { year_built: 2100 }, { service_charge: -3 }, { permit_number: "x" }, { permit_number: "<script>" }, { video_url: "javascript:alert(1)" }, { tour_url: "http://plain.example.com" }]) {
    assert.equal((await call("PATCH", `/posts/${post.id}/extras`, { token: owner.token, body: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(cleanLink("https://my.matterport.com/show/?m=1"), "https://my.matterport.com/show/?m=1");
  assert.equal(cleanLink("ftp://x.com/a"), undefined);
  assert.equal(cleanLink("nonsense"), undefined);
  assert.deepEqual(cleanExtras({ other: 1 }), { fields: {} });
});

test("views: visitors count, the owner doesn't; the number shows in the market picture", async () => {
  const { call, owner, visitor, post, details } = await setup();
  assert.deepEqual((await call("POST", `/posts/${post.id}/view`, { token: owner.token })).body, { ok: true, own: true });
  await call("POST", `/posts/${post.id}/view`, { token: visitor.token });
  await call("POST", `/posts/${post.id}/view`);
  assert.equal((await details()).market.views, 2);
  assert.equal((await call("POST", "/posts/not-an-id/view")).status, 404);
});

test("price history: each new asking price is remembered, oldest first", async () => {
  const { store, call, owner, post, details } = await setup();
  await store.insert("price_history", [{ post_id: post.id, price: 1000000, created_at: "2026-10-01T00:00:00Z" }]);
  const edit = await call("PATCH", "/posts/" + post.id, { token: owner.token, body: { deal: "sale", property_type: "apartment", bedrooms: 2, price: 900000, currency: "AED", building: "Sky", locality: "Marina", city: "Dubai", country: "United Arab Emirates", unit_number: "1203", size_sqft: 1000 } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const h = (await details()).market.history;
  assert.deepEqual(h.map((x) => x.price), [1000000, 900000]);
  assert.ok(h[1].at > h[0].at);
  // Saving again without changing the price adds nothing
  await call("PATCH", "/posts/" + post.id, { token: owner.token, body: { deal: "sale", property_type: "apartment", bedrooms: 2, price: 900000, currency: "AED", building: "Sky", locality: "Marina", city: "Dubai", country: "United Arab Emirates", unit_number: "1203", size_sqft: 1000 } });
  assert.equal((await details()).market.history.length, 2);
});

test("report a listing: signed-in visitors only, one report each, admins see them", async () => {
  const { call, owner, visitor, admin, post } = await setup();
  assert.equal((await call("POST", `/posts/${post.id}/report`, { body: { reason: "fake" } })).status, 401);
  assert.equal((await call("POST", `/posts/${post.id}/report`, { token: visitor.token, body: { reason: "nope" } })).status, 400);
  assert.equal((await call("POST", `/posts/${post.id}/report`, { token: owner.token, body: { reason: "fake" } })).status, 400);
  assert.deepEqual((await call("POST", `/posts/${post.id}/report`, { token: visitor.token, body: { reason: "gone", note: "  Agent says it sold last month  " } })).body, { ok: true });
  await call("POST", `/posts/${post.id}/report`, { token: visitor.token, body: { reason: "fake" } });
  assert.equal((await call("GET", "/admin/reports", { token: visitor.token })).status, 403);
  const list = (await call("GET", "/admin/reports", { token: admin.token })).body.reports;
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, "No longer available");
  assert.equal(list[0].note, "Agent says it sold last month");
  assert.equal(list[0].post_id, post.id);
});

test("sold or rented: the owner closes a listing; it leaves the map and how it ended is kept", async () => {
  const { store, call, owner, visitor, post } = await setup();
  assert.equal((await call("POST", `/posts/${post.id}/close`, { token: visitor.token, body: { as: "sold" } })).status, 403);
  assert.equal((await call("POST", `/posts/${post.id}/close`, { token: owner.token, body: { as: "gone" } })).status, 400);
  assert.deepEqual((await call("POST", `/posts/${post.id}/close`, { token: owner.token, body: { as: "sold" } })).body, { ok: true, closed_as: "sold" });
  const row = await store.getPost(post.id);
  assert.equal(row.status, "removed");
  assert.equal(row.closed_as, "sold");
  assert.ok(row.closed_at);
  assert.equal((await call("GET", "/map?w=55&e=55.3&s=25&n=25.2&z=13")).body.pins.length, 0);
  assert.equal((await call("POST", `/posts/${post.id}/close`, { token: owner.token, body: { as: "sold" } })).status, 404);
});

test("before the database is updated: nothing breaks", async () => {
  const { store, call, owner, visitor, post, details } = await setup();
  const rows = store.rows.bind(store), insert = store.insert.bind(store);
  store.rows = async (t, ...a) => { if (t === "price_history" || t === "reports") throw new Error("Database: relation does not exist"); return rows(t, ...a); };
  store.insert = async (t, ...a) => { if (t === "price_history" || t === "reports") throw new Error("Database: relation does not exist"); return insert(t, ...a); };
  assert.deepEqual((await details()).market.history, []);
  assert.equal((await call("POST", `/posts/${post.id}/report`, { token: visitor.token, body: { reason: "fake" } })).status, 503);
  const edit = await call("PATCH", "/posts/" + post.id, { token: owner.token, body: { deal: "sale", property_type: "apartment", bedrooms: 2, price: 800000, currency: "AED", building: "Sky", locality: "Marina", city: "Dubai", country: "United Arab Emirates", unit_number: "1203", size_sqft: 1000 } });
  assert.equal(edit.status, 200, "a price change still saves");
});
