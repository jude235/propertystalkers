import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { validateProposal, cleanRera, cleanPhone, sanitizeMessages } from "../netlify/lib/core.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

const GEO = {
  "skyview, sector 7, gurugram": { lat: 28.4700, lng: 77.0300, precision: "building", place_id: "SKY" },
  "sector 7, gurugram": { lat: 28.4710, lng: 77.0320, precision: "area" },
  "palm court, sector 7, gurugram": { lat: 28.4800, lng: 77.0400, precision: "building", place_id: "PALM" },
  "sector 150, noida": { lat: 28.42, lng: 77.48, precision: "area" },
  "marina vista, dubai marina, dubai": { lat: 25.08, lng: 55.14, precision: "building", place_id: "MV" },
  "business bay, dubai": { lat: 25.18, lng: 55.27, precision: "area" }
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
  async function setRole(u, role, extra = {}) {
    return call("POST", "/me/role", { token: u.token, body: { role, ...extra } });
  }
  async function post(u, proposal, photos = []) {
    const role = proposal.poster_type === "broker" && !proposal.rera_number ? "landlord" : proposal.poster_type;
    const rr = await setRole(u, role, { licence: proposal.rera_number, company: proposal.company });
    assert.equal(rr.status, 200, JSON.stringify(rr.body));
    ai.queue.push({ text: "Here's your draft.", proposal });
    const c = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "post it" }] } });
    assert.equal(c.body.type, "draft", JSON.stringify(c.body));
    const p = await call("POST", "/posts", { token: u.token, body: { draftId: c.body.draft.id, photos } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return p.body.post;
  }
  const feed = async (u) => (await call("GET", "/feed", { token: u && u.token })).body;
  return { store, ai, call, person, post, feed, setRole };
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
  assert.equal((await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "hi" }] } })).body.error, "role_required");
  await call("POST", "/me/role", { token: u.token, body: { role: "landlord" } });
  ai.queue.push({ text: "Which city is it in?", proposal: null });
  const r1 = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "selling 3bhk in skyview" }] } });
  assert.deepEqual(r1.body, { type: "message", text: "Which city is it in?" });
  assert.equal(ai.roles[ai.roles.length - 1], "landlord");

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
  const { call, person, ai, setRole } = setup();
  const u = await person("r@x.in");
  await setRole(u, "buyer");
  for (let i = 0; i < 40; i++) {
    ai.queue.push({ text: "?", proposal: null });
    await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "hi" }] } });
  }
  const r = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal(r.status, 429);
});

test("roles: choose, validate, switch", async () => {
  const { call, person, post, feed, setRole, ai } = setup();
  const u = await person("roles@x.in");
  assert.equal((await setRole(u, "astronaut")).status, 400);
  assert.equal((await setRole(u, "broker")).status, 400);                 // licence required
  assert.equal((await setRole(u, "developer")).status, 400);              // company required
  const b = await setRole(u, "broker", { licence: "BRN 12345" });
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.access, { requests: true });
  const buyer = await person("b@x.in");
  await post(buyer, buyerReq);
  assert.equal((await feed(u)).posts.filter((p) => p.kind === "request").length, 1);
  // switching away from broker hides requests
  const s2 = await setRole(u, "buyer");
  assert.deepEqual(s2.body.access, { requests: false });
  assert.equal((await feed(u)).posts.filter((p) => p.kind === "request").length, 0);
  // the chosen role overrides whatever the AI guessed
  await setRole(u, "landlord");
  ai.queue.push({ text: "", proposal: { ...landlordSale, poster_type: "buyer" } });
  const r = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "x" }] } });
  assert.equal(r.body.draft.poster_type, "landlord");
});

test("developer form creates a draft without the AI", async () => {
  const { call, person, setRole, ai } = setup();
  const d = await person("form@x.in");
  await setRole(d, "developer", { company: "Sample Developers" });
  const r = await call("POST", "/draft", { token: d.token, body: {
    company: "Sample Developers", project: "Skyview", area: "Sector 7", city: "Gurugram", rera: "RC/REP/HARERA/GGM/2026/09",
    property_type: "apartment", configs: "2, 3 & 4 BHK", bedrooms: 2, price: 21000000, currency: "INR", possession: "Mar 2029",
    description: "Tower with sky deck." } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.draft.poster_type, "developer");
  assert.equal(r.body.draft.configs, "2, 3 & 4 BHK");
  assert.equal(r.body.draft.possession, "Mar 2029");
  assert.equal(ai.calls.length, 0);
  const p = await call("POST", "/posts", { token: d.token, body: { draftId: r.body.draft.id } });
  assert.equal(p.body.post.configs, "2, 3 & 4 BHK");
  const bad = await call("POST", "/draft", { token: d.token, body: { company: "X", project: "Nowhere", area: "Sector 999", city: "Atlantis" } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /couldn't find/);
});

test("editing: owner can change price, details, photos and location; others can't", async () => {
  const { call, person, post, feed } = setup();
  const owner = await person("own@x.in");
  const other = await person("oth@x.in");
  const p = await post(owner, { poster_type: "landlord", deal: "sale", property_type: "apartment", bedrooms: 3, price: 15000000, building: "Skyview", locality: "Sector 7", city: "Gurugram" });
  const prefix = `${ENV.SUPABASE_URL}/storage/v1/object/public/photos/`;
  const ownerId = (await call("GET", "/me", { token: owner.token })).body.profile.id;

  const no = await call("PATCH", "/posts/" + p.id, { token: other.token, body: { price: 1 } });
  assert.equal(no.status, 403);
  assert.equal((await call("PATCH", "/posts/" + p.id, { body: { price: 1 } })).status, 401);

  const r = await call("PATCH", "/posts/" + p.id, { token: owner.token, body: {
    price: 14500000, bedrooms: 4, description: "Price reduced",
    photos: [prefix + ownerId + "/a.jpg", prefix + "someone-else/b.jpg"] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.post.price, 14500000);
  assert.equal(r.body.post.bedrooms, 4);
  assert.equal(r.body.post.description, "Price reduced");
  assert.deepEqual(r.body.post.photos, [prefix + ownerId + "/a.jpg"]);
  assert.equal(r.body.post.lat, 28.47); // not moved

  const moved = await call("PATCH", "/posts/" + p.id, { token: owner.token, body: { building: "Palm Court" } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.post.lat, 28.48);

  const bad = await call("PATCH", "/posts/" + p.id, { token: owner.token, body: { locality: "Nowhere", building: "", city: "Atlantis" } });
  assert.equal(bad.status, 400);
  const seen = (await feed()).posts.find((x) => x.id === p.id);
  assert.equal(seen.price, 14500000);
  assert.equal(seen.lat, 28.48);
});

test("profile: email and mobile required, licence optional and checked", async () => {
  const { call, store } = setup();
  const u = store.addUser("p@x.in");
  const phoneUser = { ...store.addUser("ph@x.in") };
  store._users.get(phoneUser.token).email = null; // signed in with a mobile number
  let r = await call("POST", "/me", { token: phoneUser.token, body: { name: "Asha", phone: "+971501234567" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /email/);
  r = await call("POST", "/me", { token: phoneUser.token, body: { name: "Asha", phone: "+971501234567", email: "asha@x.ae" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.email, "asha@x.ae");
  r = await call("POST", "/me", { token: u.token, body: { name: "Ravi", phone: "", email: "p@x.in" } });
  assert.equal(r.status, 400);
  r = await call("POST", "/me", { token: u.token, body: { name: "Ravi", phone: "+919876543210", rera: "!!" } });
  assert.equal(r.status, 400);
  r = await call("POST", "/me", { token: u.token, body: { name: "Ravi", phone: "+919876543210", rera: "BRN 12345" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.email, "p@x.in");
  assert.ok(r.body.profile.rera_number);
  // switching role keeps the contact email
  await call("POST", "/me/role", { token: phoneUser.token, body: { role: "landlord" } });
  assert.equal((await call("GET", "/me", { token: phoneUser.token })).body.profile.email, "asha@x.ae");
  // a broker can't clear their licence
  await call("POST", "/me/role", { token: u.token, body: { role: "broker", licence: "BRN 12345" } });
  r = await call("POST", "/me", { token: u.token, body: { name: "Ravi", phone: "+919876543210", rera: "" } });
  assert.equal(r.status, 400);
});

test("admin DLD import: admins only, creates developer listings once, skips unplaceable", async () => {
  const { call, person, feed, store } = setup();
  const admin = await person("admin@ps.in", "Admin", "971501234567");
  const other = await person("x@ps.in");
  const projects = [
    { id: 101, name: "Marina Vista", area: "Dubai Marina", developer: "Emaar", completion: "Dec 2027", status: "Active", percent: 42.4, units: 120, villas: 0 },
    { id: 102, name: "Nowhere Tower", area: "Business Bay", developer: "Damac", completion: "2028", status: "Active", percent: 5 },
    { id: 103, name: "Lost One", area: "Atlantis Zone", developer: "Someone", status: "Active" },
    { id: 104, name: "", area: "Business Bay", developer: "Nobody" }
  ];
  assert.equal((await call("POST", "/admin/import-projects", { token: other.token, body: { projects } })).status, 403);
  const r = await call("POST", "/admin/import-projects", { token: admin.token, body: { projects } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 2);
  assert.deepEqual(r.body.unplaced, ["103"]);
  const again = await call("POST", "/admin/import-projects", { token: admin.token, body: { projects } });
  assert.equal(again.body.created, 0);
  assert.equal(again.body.skipped, 2);
  const posts = (await feed(null)).posts.filter((p) => p.source === "dld");
  assert.equal(posts.length, 2);
  const mv = posts.find((p) => p.building === "Marina Vista");
  assert.equal(mv.poster_type, "developer");
  assert.equal(mv.company, "Emaar");
  assert.equal(mv.possession, "Dec 2027");
  assert.equal(mv.price, null);
  assert.equal(mv.configs, "120 units");
  assert.equal(mv.property_type, "apartment");
  assert.match(mv.description, /42% built/);
  assert.equal(mv.contact_name, "Property Stalkers enquiries");
  assert.equal(posts.find((p) => p.building === "Nowhere Tower").precision, "area");
  assert.equal(store._posts.filter((p) => p.building_key === "dld:101").length, 1);
});
