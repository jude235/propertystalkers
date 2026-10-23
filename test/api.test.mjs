import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { validateProposal, cleanRera, cleanPhone, sanitizeMessages } from "../netlify/lib/core.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

const GEO = {
  "skyview, sector 7, gurugram": { lat: 28.4700, lng: 77.0300, precision: "building", place_id: "SKY" },
  "sector 7, gurugram": { lat: 28.4710, lng: 77.0320, precision: "area" },
  "palm court, sector 7, gurugram": { lat: 28.4800, lng: 77.0400, precision: "building", place_id: "PALM" },
  "sector 150, noida": { lat: 28.42, lng: 77.48, precision: "area" }
};

function setup() {
  const store = memoryStore();
  const ai = scriptedAI();
  const deps = { store, ai, geo: tableGeo(GEO), env: ENV };
  const call = async (...a) => { const r = await handle(req(...a), deps); return { status: r.status, body: await r.json() }; };
  async function person(email, name = "Test Person", phone = "9876543210") {
    const u = store.addUser(email);
    const r = await call("POST", "/me", { token: u.token, body: { name, phone } });
    assert.equal(r.status, 200);
    return u;
  }
  async function post(u, proposal, photos = []) {
    ai.queue.push({ text: "Here's your draft.", proposal });
    const c = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "post it" }] } });
    assert.equal(c.body.type, "draft", JSON.stringify(c.body));
    const p = await call("POST", "/posts", { token: u.token, body: { draftId: c.body.draft.id, photos } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return p.body.post;
  }
  const feed = async (u) => (await call("GET", "/feed", { token: u && u.token })).body;
  return { store, ai, call, person, post, feed };
}

const landlordSale = { poster_type: "landlord", deal: "sale", property_type: "apartment", bedrooms: 3, price: 15000000,
  building: "Skyview", locality: "Sector 7", city: "Gurugram", description: "3 BHK in Skyview." };
const buyerReq = { poster_type: "buyer", deal: "sale", bedrooms: 3, price: 14000000, building: "Skyview", locality: "Sector 7", city: "Gurugram", description: "Wants 3 BHK." };
const tenantReq = { poster_type: "tenant", deal: "rent", bedrooms: 2, price: 45000, building: "Skyview", locality: "Sector 7", city: "Gurugram", description: "Wants 2 BHK on rent." };

test("config hides server secrets", async () => {
  const { call } = setup();
  const r = await call("GET", "/config");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["mapId", "mapsKey", "supabaseAnonKey", "supabaseUrl"]);
});

test("validation: broker without RERA becomes landlord; location and city required", () => {
  const v = validateProposal({ poster_type: "broker", deal: "sale", locality: "Sector 7", city: "Gurugram", rera_number: "" });
  assert.equal(v.ok, true);
  assert.equal(v.post.poster_type, "landlord");
  assert.equal(v.post.kind, "listing");
  assert.equal(v.post.notes.length, 1);

  const b = validateProposal({ poster_type: "broker", deal: "sale", locality: "Sector 7", city: "Gurugram", rera_number: "rc/rep/harera/ggm/123/2024/45" });
  assert.equal(b.post.poster_type, "broker");
  assert.equal(b.post.rera_number, "RC/REP/HARERA/GGM/123/2024/45");

  assert.equal(validateProposal({ poster_type: "landlord", deal: "sale", city: "Pune" }).ok, false);
  assert.equal(validateProposal({ poster_type: "landlord", deal: "sale", building: "Skyview" }).ok, false);
  assert.equal(validateProposal({ poster_type: "landlord", building: "X", city: "Pune" }).ok, false); // sell or rent?
  const t = validateProposal({ poster_type: "tenant", deal: "sale", locality: "Baner", city: "Pune" });
  assert.equal(t.post.deal, "rent");
  assert.equal(t.post.kind, "request");
});

test("helpers", () => {
  assert.equal(cleanRera("hello"), null);
  assert.equal(cleanRera("P51700012345"), "P51700012345");
  assert.equal(cleanPhone("098765 43210"), "919876543210");
  assert.equal(cleanPhone("+91 98765-43210"), "919876543210");
  assert.equal(cleanPhone("12345"), null);
  assert.equal(cleanPhone("+971 50 123 4567"), "971501234567");
  assert.equal(cleanPhone("00971501234567"), "971501234567");
  assert.equal(cleanPhone("050 123 4567"), null); // local number without country code
  const m = sanitizeMessages([{ role: "assistant", content: "hi" }, { role: "user", content: "a" }, { role: "user", content: "b" }, { role: "system", content: "x" }]);
  assert.deepEqual(m, [{ role: "user", content: "a\nb" }]);
});

test("signed-out visitors see listings only", async () => {
  const { person, post, feed } = setup();
  const owner = await person("owner@x.in");
  const buyer = await person("buyer@x.in");
  const tenant = await person("tenant@x.in");
  await post(owner, landlordSale);
  await post(buyer, buyerReq);
  await post(tenant, tenantReq);
  const f = await feed(null);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].kind, "listing");
  assert.equal(f.posts[0].user_id, undefined);
});

test("visibility: requests are only for licensed brokers", async () => {
  const { person, post, feed } = setup();
  const owner = await person("owner@x.in");            // landlord in Skyview
  const broker = await person("broker@x.in");
  const buyer = await person("buyer@x.in");
  const tenant = await person("tenant@x.in");
  const nobody = await person("nobody@x.in");
  const admin = await person("admin@ps.in");

  await post(owner, landlordSale);
  await post(broker, { poster_type: "broker", deal: "rent", rera_number: "RC/REP/HARERA/GGM/2024/45", locality: "Sector 150", city: "Noida", description: "Villa." });
  await post(buyer, buyerReq);
  await post(tenant, tenantReq);

  const kinds = async (u) => (await feed(u)).posts.map((p) => `${p.kind}:${p.poster_type}`).sort();

  // Landlord (even in the same building): listings only
  assert.deepEqual(await kinds(owner), ["listing:broker", "listing:landlord"]);
  // Licensed broker: everything
  assert.deepEqual(await kinds(broker), ["listing:broker", "listing:landlord", "request:buyer", "request:tenant"]);
  // Buyer / tenant: listings + own request only
  assert.deepEqual(await kinds(buyer), ["listing:broker", "listing:landlord", "request:buyer"]);
  assert.deepEqual(await kinds(tenant), ["listing:broker", "listing:landlord", "request:tenant"]);
  assert.deepEqual(await kinds(nobody), ["listing:broker", "listing:landlord"]);
  assert.equal((await feed(admin)).posts.length, 4);

  assert.deepEqual((await feed(owner)).access, { requests: false });
  assert.deepEqual((await feed(broker)).access, { requests: true });
  assert.deepEqual((await feed(null)).access, { requests: false });
});

test("developer listings", async () => {
  const { person, post, feed } = setup();
  const dev = await person("dev@x.in", "Sales Desk", "+971501234567");
  const p = await post(dev, { poster_type: "developer", company: "Sample Developers", building: "Skyview", locality: "Sector 7",
    city: "Gurugram", price: 25000000, currency: "INR", bedrooms: 3, possession: "Dec 2028", rera_number: "RC/REP/HARERA/GGM/2026/01",
    description: "3 and 4 BHK residences." });
  assert.equal(p.kind, "listing");
  assert.equal(p.deal, "sale");
  assert.equal(p.company, "Sample Developers");
  assert.equal(p.possession, "Dec 2028");
  assert.equal(p.contact_phone, "971501234567");
  assert.equal((await feed(null)).posts.length, 1);           // public
  const v = validateProposal({ poster_type: "developer", building: "X", city: "Pune", description: "x" });
  assert.equal(v.ok, false);                                   // company name required
  assert.match(v.ask, /developer company/);
});

test("area search uses the geocoder and caches", async () => {
  const { call } = setup();
  const r = await call("GET", "/geocode?q=sector%207%2C%20gurugram");
  assert.equal(r.status, 200);
  assert.equal(r.body.place.lat, 28.471);
  assert.equal((await call("GET", "/geocode?q=a")).body.place, null);
});

test("broker RERA is saved to the profile; posts carry the poster's contact", async () => {
  const { person, post, store } = setup();
  const broker = await person("broker@x.in", "Aditya", "9811122233");
  const p = await post(broker, { poster_type: "broker", deal: "sale", property_type: "villa", price: 50000000,
    rera_number: "P51700012345", locality: "Sector 7", city: "Gurugram", description: "Villa for 5 Cr." });
  assert.equal(p.rera_number, "P51700012345");
  assert.equal(p.contact_phone, "919811122233");
  assert.equal(p.precision, "area");
  assert.equal(store._profiles.get(store._users.get(broker.token).id).rera_number, "P51700012345");
});

test("chat: plain replies, profile required, ungeocodable location, drafts are private", async () => {
  const { call, person, ai, store } = setup();
  const noProfile = store.addUser("np@x.in");
  assert.equal((await call("POST", "/chat", { token: noProfile.token, body: { messages: [{ role: "user", content: "hi" }] } })).body.error, "profile_required");
  assert.equal((await call("POST", "/chat", { body: { messages: [] } })).status, 401);

  const u = await person("u@x.in");
  ai.queue.push({ text: "Which city is it in?", proposal: null });
  const r1 = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "selling 3bhk in skyview" }] } });
  assert.deepEqual(r1.body, { type: "message", text: "Which city is it in?" });

  ai.queue.push({ text: "", proposal: { ...landlordSale, building: "Nowhere Towers", locality: "Sector 999", city: "Atlantis" } });
  const r2 = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "x" }] } });
  assert.equal(r2.body.type, "message");
  assert.match(r2.body.text, /couldn't find/);

  ai.queue.push({ text: "", proposal: landlordSale });
  const r3 = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "x" }] } });
  const other = await person("other@x.in");
  const steal = await call("POST", "/posts", { token: other.token, body: { draftId: r3.body.draft.id } });
  assert.equal(steal.status, 404);
  assert.equal((await call("POST", "/posts", { token: u.token, body: { draftId: "not-a-uuid" } })).status, 404);
});

test("worldwide: currency and country are kept", async () => {
  const v = validateProposal({ poster_type: "landlord", deal: "sale", property_type: "villa", price: 4500000, currency: "aed",
    building: "Portofino", locality: "Damac Lagoons", city: "Dubai", country: "United Arab Emirates", description: "Villa." });
  assert.equal(v.post.currency, "AED");
  assert.equal(v.post.country, "United Arab Emirates");
  const d = validateProposal({ poster_type: "buyer", price: 12000000, locality: "Kharadi", city: "Pune", description: "x" });
  assert.equal(d.post.currency, "INR");
});

test("only photos from the user's own storage folder are kept", async () => {
  const { person, post, store } = setup();
  const u = await person("p@x.in");
  const uid = store._users.get(u.token).id;
  const good = `${ENV.SUPABASE_URL}/storage/v1/object/public/photos/${uid}/a.jpg`;
  const p = await post(u, landlordSale, [good, "https://evil.com/x.jpg", `${ENV.SUPABASE_URL}/storage/v1/object/public/photos/someone-else/b.jpg`]);
  assert.deepEqual(p.photos, [good]);
});

test("removing posts: owner and admin only", async () => {
  const { call, person, post, feed } = setup();
  const owner = await person("o@x.in");
  const stranger = await person("s@x.in");
  const admin = await person("admin@ps.in");
  const p1 = await post(owner, landlordSale);
  const p2 = await post(owner, { ...landlordSale, building: "Palm Court" });
  assert.equal((await call("DELETE", "/posts/" + p1.id, { token: stranger.token })).status, 403);
  assert.equal((await call("DELETE", "/posts/" + p1.id, { token: owner.token })).status, 200);
  assert.equal((await call("DELETE", "/posts/" + p2.id, { token: admin.token })).status, 200);
  assert.equal((await feed(null)).posts.length, 0);
});

test("rate limits", async () => {
  const { call, person, ai } = setup();
  const u = await person("r@x.in");
  for (let i = 0; i < 40; i++) {
    ai.queue.push({ text: "?", proposal: null });
    await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "hi" }] } });
  }
  const r = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal(r.status, 429);
});
