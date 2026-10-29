// The five roles, holiday homes by the night, and co-living interests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { validateProposal, roleOf, sharedInterests, cleanInterests, unitKey } from "../netlify/lib/core.mjs";
import { postTitle } from "../netlify/lib/events.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

const GEO = { "marina vista, dubai marina, dubai": { lat: 25.08, lng: 55.14, precision: "building", place_id: "MV" },
  "dubai marina, dubai": { lat: 25.08, lng: 55.14, precision: "area" } };

function setup() {
  const store = memoryStore();
  const ai = scriptedAI();
  const deps = { store, ai, geo: tableGeo(GEO), env: ENV };
  const call = async (...a) => { const r = await handle(req(...a), deps); return { status: r.status, body: await r.json() }; };
  async function person(email, role, extra = {}) {
    const u = store.addUser(email);
    assert.equal((await call("POST", "/me", { token: u.token, body: { name: "Test " + email, phone: "+971501234567" } })).status, 200);
    if (role) assert.equal((await call("POST", "/me/role", { token: u.token, body: { role, ...extra } })).status, 200);
    return u;
  }
  async function post(u, proposal, extra = {}) {
    ai.queue.push({ text: "Draft.", proposal });
    const c = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "post it" }] } });
    if (c.body.type !== "draft") return c;
    return call("POST", "/posts", { token: u.token, body: { draftId: c.body.draft.id, ...extra } });
  }
  return { store, ai, call, person, post };
}
const where = { building: "Marina Vista", locality: "Dubai Marina", city: "Dubai", country: "United Arab Emirates", currency: "AED" };

test("old buyer and tenant roles are the same Buyer / Tenant role", () => {
  assert.equal(roleOf("buyer"), "seeker");
  assert.equal(roleOf("tenant"), "seeker");
  assert.equal(roleOf("host"), "host");
  assert.equal(roleOf("nonsense"), null);
});

test("Buyer / Tenant posts a buy request or a rent request from the same role", async () => {
  const { call, person, post, ai } = setup();
  const u = await person("seek@x.in", "seeker");
  assert.equal((await call("GET", "/me", { token: u.token })).body.profile.role, "seeker");
  const buy = await post(u, { deal: "sale", bedrooms: 2, price: 2000000, ...where, description: "Want to buy" });
  assert.equal(buy.status, 200, JSON.stringify(buy.body));
  assert.equal(buy.body.post.kind, "request");
  assert.equal(buy.body.post.poster_type, "buyer");
  const rent = await post(u, { deal: "rent", bedrooms: 1, price: 90000, ...where, description: "Want to rent" });
  assert.equal(rent.body.post.poster_type, "tenant");
  assert.equal(rent.body.post.deal, "rent");
  const room = await post(u, { deal: "share", room_type: "private_room", price: 3000, ...where, interests: ["yoga", "non_smoker", "bogus"], description: "Looking for a room" });
  assert.equal(room.body.post.kind, "request");
  assert.deepEqual(room.body.post.interests, ["yoga", "non_smoker"]);
  assert.equal(ai.roles.at(-1), "seeker", "the assistant is told the merged role");
});

test("a host lists a holiday home by the night, unit number required, size optional", async () => {
  const { person, post } = setup();
  const h = await person("host@x.in", "host");
  const noUnit = await post(h, { deal: "stay", price: 450, bedrooms: 2, guests: 4, ...where, description: "Sea view" });
  assert.match(noUnit.body.text, /unit/i);
  const ok = await post(h, { deal: "stay", price: 450, bedrooms: 2, guests: 4, min_nights: 2, unit_number: "1204", ...where, description: "Sea view" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const p = ok.body.post;
  assert.equal(p.kind, "listing");
  assert.equal(p.poster_type, "host");
  assert.equal(p.deal, "stay");
  assert.equal(p.guests, 4);
  assert.equal(p.min_nights, 2);
  assert.equal(p.size_sqft, null);
  assert.equal(postTitle(p), "2 BHK holiday home in Marina Vista, Dubai Marina, Dubai");
});

test("a host shares a co-living room with household interests", async () => {
  const { person, post } = setup();
  const h = await person("coliv@x.in", "host");
  const r = await post(h, { deal: "share", room_type: "private_room", room: "Room 2", price: 3500, unit_number: "804", suits: "female",
    interests: ["professional", "yoga", "cooking"], ...where, description: "Looking for a working woman, no parties." }, { share_permission: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.post.poster_type, "host");
  assert.deepEqual(r.body.post.interests, ["professional", "yoga", "cooking"]);
});

test("a host is asked which kind when it isn't co-living or a holiday home", () => {
  const v = validateProposal({ poster_type: "host", deal: "sale", ...where, unit_number: "1", description: "x" });
  assert.equal(v.ok, false);
  assert.match(v.ask, /co-living|holiday home/i);
});

test("owners can let a holiday home too, and stays count separately from rent", () => {
  const v = validateProposal({ poster_type: "landlord", deal: "stay", price: 300, unit_number: "5", ...where, description: "x" });
  assert.equal(v.ok, true);
  assert.equal(v.post.size_sqft, null);
  assert.notEqual(unitKey({ ...v.post }), unitKey({ ...v.post, deal: "rent" }));
});

test("people save interests on their profile, and shared interests are counted", async () => {
  const { call, person } = setup();
  const u = await person("int@x.in", "seeker");
  const r = await call("POST", "/me", { token: u.token, body: { name: "Int", phone: "+971501234567", interests: ["yoga", "gaming", "yoga", "hack"] } });
  assert.deepEqual(r.body.profile.interests, ["yoga", "gaming"]);
  assert.deepEqual(sharedInterests(["yoga", "gaming"], ["cooking", "yoga"]), ["yoga"]);
  assert.deepEqual(cleanInterests("nope"), []);
});

test("the feed carries interests, guests and nights", async () => {
  const { call, person, post } = setup();
  const h = await person("feed@x.in", "host");
  await post(h, { deal: "stay", price: 600, guests: 6, min_nights: 3, unit_number: "77", ...where, description: "Villa stay" });
  const feed = (await call("GET", "/feed")).body.posts;
  const s = feed.find((p) => p.deal === "stay");
  assert.equal(s.guests, 6);
  assert.equal(s.min_nights, 3);
  assert.deepEqual(s.interests, []);
});
