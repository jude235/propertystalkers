// Phase 1 + 2: alerts, price drops, request matcher and pitches, enquiries and viewings, tenancies and jobs,
// safety flags, market badges and the "Ask Stalker" assistant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { runJobs } from "../netlify/lib/jobs.mjs";
import { affordability } from "../netlify/lib/assistant.mjs";
import { marketInfo, textFlags, listingFitsRequest, matchesCriteria } from "../netlify/lib/market.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

const GEO = {
  "skyview, sector 7, gurugram": { lat: 28.47, lng: 77.03, precision: "building", place_id: "SKY" },
  "sector 7, gurugram": { lat: 28.471, lng: 77.032, precision: "area" },
  "palm court, sector 7, gurugram": { lat: 28.48, lng: 77.04, precision: "building", place_id: "PALM" }
};

function setup() {
  const store = memoryStore();
  const ai = scriptedAI();
  const mail = { sent: [], async send(m) { this.sent.push(...m); } };
  const deps = { store, ai, geo: tableGeo(GEO), env: ENV, mail };
  const call = async (method, path, opts = {}) => { const r = await handle(req(method, path, opts), deps); return { status: r.status, body: await r.json() }; };
  let n = 0;
  async function person(email, name = "Test Person", phone = "9876543210") {
    const u = store.addUser(email);
    assert.equal((await call("POST", "/me", { token: u.token, body: { name, phone, email } })).status, 200);
    return u;
  }
  async function post(u, proposal, extra = {}) {
    const lister = ["landlord", "broker"].includes(proposal.poster_type);
    if (lister) proposal = { unit_number: `U${++n}`, size_sqft: 1000, ...proposal };
    const role = proposal.poster_type;
    await call("POST", "/me/role", { token: u.token, body: { role, licence: proposal.rera_number, company: proposal.company } });
    ai.queue.push({ text: "", proposal });
    const c = await call("POST", "/chat", { token: u.token, body: { messages: [{ role: "user", content: "post" }] } });
    assert.equal(c.body.type, "draft", JSON.stringify(c.body));
    const p = await call("POST", "/posts", { token: u.token, body: { draftId: c.body.draft.id, ...extra } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return p.body.post;
  }
  const inbox = async (u) => (await call("GET", "/notifications", { token: u.token })).body;
  const feed = async (u) => (await call("GET", "/feed", { token: u && u.token })).body.posts;
  return { store, ai, mail, deps, call, person, post, inbox, feed };
}

const sale = (o = {}) => ({ poster_type: "landlord", deal: "sale", property_type: "apartment", bedrooms: 3, price: 15000000, currency: "INR",
  building: "Skyview", locality: "Sector 7", city: "Gurugram", description: "3 BHK in Skyview.", ...o });
const want = (o = {}) => ({ poster_type: "buyer", deal: "sale", property_type: "apartment", bedrooms: 3, price: 16000000, currency: "INR",
  locality: "Sector 7", city: "Gurugram", description: "Looking for a 3 BHK.", ...o });

test("alerts: saved search is told about a new matching listing, by bell and email", async () => {
  const { call, person, post, inbox, mail } = setup();
  const buyer = await person("alice@x.in", "Alice");
  const owner = await person("owner@x.in", "Owner");
  const bad = await call("POST", "/alerts", { token: buyer.token, body: { criteria: { deal: "sale" } } });
  assert.equal(bad.status, 400);
  const a = await call("POST", "/alerts", { token: buyer.token, body: { criteria: { deal: "sale", city: "Gurugram", min_bedrooms: 3, max_price: 20000000 } } });
  assert.equal(a.status, 200);
  assert.match(a.body.alert.label, /3\+ bed.*Gurugram/);
  await post(owner, sale());
  await post(owner, sale({ price: 30000000, building: "Palm Court" })); // too expensive
  const n = await inbox(buyer);
  assert.equal(n.items.filter((x) => x.kind === "alert").length, 1);
  assert.equal(n.unread, 1);
  assert.ok(mail.sent.some((m) => m.email === "alice@x.in" && /New match/.test(m.title)));
  assert.equal((await inbox(owner)).items.filter((x) => x.kind === "alert").length, 0); // not told about your own
  await call("POST", "/notifications/read", { token: buyer.token, body: {} });
  assert.equal((await inbox(buyer)).unread, 0);
  const list = await call("GET", "/alerts", { token: buyer.token });
  await call("DELETE", "/alerts/" + list.body.alerts[0].id, { token: buyer.token });
  assert.equal((await call("GET", "/alerts", { token: buyer.token })).body.alerts.length, 0);
});

test("price drops: watchers are told; first price kept for price-cut badges", async () => {
  const { call, person, post, inbox, feed } = setup();
  const owner = await person("o@x.in", "Owner");
  const fan = await person("fan@x.in", "Fan");
  const p = await post(owner, sale());
  assert.equal((await call("POST", `/posts/${p.id}/watch`, { token: fan.token })).body.watching, true);
  assert.equal((await feed(fan)).find((x) => x.id === p.id).watched, true);
  await call("PATCH", `/posts/${p.id}`, { token: owner.token, body: { price: 16000000 } }); // a rise: no alert
  assert.equal((await inbox(fan)).items.length, 0);
  const drop = await call("PATCH", `/posts/${p.id}`, { token: owner.token, body: { price: 13500000 } });
  assert.equal(drop.status, 200, JSON.stringify(drop.body));
  const n = (await inbox(fan)).items;
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Price dropped/);
  assert.equal((await feed(null)).find((x) => x.id === p.id).price_cut_pct, 10);
  await call("DELETE", `/posts/${p.id}/watch`, { token: fan.token });
  assert.equal((await feed(fan)).find((x) => x.id === p.id).watched, false);
});

test("request matcher: new listing tells fitting requesters; new request invites fitting listers to pitch", async () => {
  const { call, person, post, inbox } = setup();
  const buyer = await person("b@x.in", "Bina");
  const owner = await person("o@x.in", "Ravi");
  const r = await post(buyer, want());
  const l = await post(owner, sale());
  const bi = (await inbox(buyer)).items;
  assert.ok(bi.some((x) => x.kind === "match" && x.post_id === l.id));
  // A second request arrives after the listing: the owner is invited to pitch.
  const buyer2 = await person("b2@x.in", "Chitra");
  const r2 = await post(buyer2, want({ price: 15500000 }));
  const invite = (await inbox(owner)).items.find((x) => x.kind === "pitch_invite" && x.ref_id === r2.id);
  assert.ok(invite, "owner invited to pitch");
  assert.ok(!/9876543210/.test(invite.body), "buyer's number isn't revealed");
  // The owner pitches; the buyer hears about it with the owner's number; no double pitching.
  const p1 = await call("POST", `/requests/${r2.id}/pitch`, { token: owner.token, body: { post_id: l.id, message: "Ready to move in." } });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal((await call("POST", `/requests/${r2.id}/pitch`, { token: owner.token, body: { post_id: l.id } })).status, 409);
  const got = (await inbox(buyer2)).items.find((x) => x.kind === "pitch");
  assert.equal(got.enquiry.from.name, "Ravi");
  assert.equal(got.enquiry.from.phone, "919876543210");
  // A stranger can't pitch someone else's listing, and an owner can't pitch a listing that doesn't fit.
  const other = await person("x@x.in", "Xavier");
  assert.equal((await call("POST", `/requests/${r2.id}/pitch`, { token: other.token, body: { post_id: l.id } })).status, 403);
  const far = await post(owner, sale({ building: "Palm Court", price: 90000000 }));
  assert.equal((await call("POST", `/requests/${r.id}/pitch`, { token: owner.token, body: { post_id: far.id } })).status, 403);
});

test("enquiries and viewings: lister gets the enquirer's number; lister's number goes back only on accept; reminders", async () => {
  const { call, person, post, inbox, deps, store } = setup();
  const owner = await person("o@x.in", "Ravi", "9811111111");
  const buyer = await person("b@x.in", "Bina", "9822222222");
  const l = await post(owner, sale());
  assert.equal((await call("POST", `/posts/${l.id}/enquire`, { token: owner.token, body: { kind: "question", message: "hi" } })).status, 400); // own listing
  const q = await call("POST", `/posts/${l.id}/enquire`, { token: buyer.token, body: { kind: "question", message: "Is parking included?", summary: "Budget 1.5 Cr, cash, moving in 2 months" } });
  assert.equal(q.status, 200);
  const oi = (await inbox(owner)).items.find((x) => x.kind === "enquiry_question");
  assert.match(oi.body, /parking/);
  assert.equal(oi.enquiry.from.phone, "919822222222");
  assert.equal((await call("POST", `/posts/${l.id}/enquire`, { token: buyer.token, body: { kind: "viewing", slot: "2001-01-01T10:00:00Z" } })).status, 400);
  const slot = new Date(Date.now() + 5 * 3600000).toISOString();
  const v = await call("POST", `/posts/${l.id}/enquire`, { token: buyer.token, body: { kind: "viewing", slot } });
  assert.equal(v.status, 200);
  let bv = (await inbox(owner)).items.find((x) => x.kind === "enquiry_viewing");
  assert.equal(bv.enquiry.status, "new");
  // Before accepting, the buyer can't see the owner's number on that viewing.
  const sentBefore = await call("GET", "/enquiries", { token: buyer.token });
  assert.equal(sentBefore.body.sent.length, 2);
  assert.equal((await call("POST", `/enquiries/${v.body.enquiry_id}`, { token: buyer.token, body: { status: "accepted" } })).status, 404); // not theirs to answer
  assert.equal((await call("POST", `/enquiries/${v.body.enquiry_id}`, { token: owner.token, body: { status: "accepted" } })).status, 200);
  const conf = (await inbox(buyer)).items.find((x) => x.kind === "viewing_accepted");
  assert.equal(conf.enquiry.to.phone, "919811111111");
  // The day before, both get a reminder.
  const done = await runJobs(deps);
  assert.equal(done.viewings, 1);
  assert.ok((await inbox(owner)).items.some((x) => x.kind === "viewing_reminder"));
  assert.ok((await inbox(buyer)).items.some((x) => x.kind === "viewing_reminder"));
  assert.equal((await runJobs(deps)).viewings, 0); // only once
  // Co-broking: only for brokers, only on listings open to it.
  const broker = await person("br@x.in", "Brok");
  await call("POST", "/me/role", { token: broker.token, body: { role: "broker", licence: "BRN 12345" } });
  assert.equal((await call("POST", `/posts/${l.id}/enquire`, { token: broker.token, body: { kind: "cobroke" } })).status, 400);
  assert.equal((await call("POST", `/posts/${l.id}/enquire`, { token: buyer.token, body: { kind: "cobroke" } })).status, 403);
});

test("co-broking flag: brokers can open a listing to co-broking; other brokers see it", async () => {
  const { call, person, post, feed } = setup();
  const b1 = await person("b1@x.in", "Broker One");
  const b2 = await person("b2@x.in", "Broker Two");
  const visitor = await person("v@x.in", "Visitor");
  const l = await post(b1, sale({ poster_type: "broker", rera_number: "BRN 11111" }), { cobroke: true });
  await call("POST", "/me/role", { token: b2.token, body: { role: "broker", licence: "BRN 22222" } });
  assert.equal((await feed(b2)).find((x) => x.id === l.id).cobroke, true);
  assert.equal((await feed(visitor)).find((x) => x.id === l.id).cobroke, false);
  const r = await call("POST", `/posts/${l.id}/enquire`, { token: b2.token, body: { kind: "cobroke", message: "I have a buyer." } });
  assert.equal(r.status, 200);
});

test("stale listings: asked after 30 days, taken off after 7 more, back on when confirmed", async () => {
  const { call, person, post, inbox, deps, store, feed } = setup();
  const owner = await person("o@x.in", "Owner");
  const l = await post(owner, sale());
  const now = Date.now();
  const row = store._posts.find((p) => p.id === l.id);
  row.confirmed_at = new Date(now - 31 * 86400000).toISOString();
  assert.equal((await runJobs(deps, now)).stale, 1);
  assert.ok((await inbox(owner)).items.some((x) => x.kind === "stale" && x.post_id === l.id));
  assert.equal((await feed(owner)).find((x) => x.id === l.id).needs_confirm, true);
  assert.equal((await runJobs(deps, now + 8 * 86400000)).expired, 1);
  assert.equal((await feed(null)).some((x) => x.id === l.id), false);
  const stranger = await person("s@x.in");
  assert.equal((await call("POST", `/posts/${l.id}/confirm`, { token: stranger.token })).status, 403);
  assert.equal((await call("POST", `/posts/${l.id}/confirm`, { token: owner.token })).status, 200);
  assert.equal((await feed(null)).some((x) => x.id === l.id), true);
});

test("tenancies: rent and renewal reminders, tenant email, repair link", async () => {
  const { call, person, inbox, deps, mail } = setup();
  const ll = await person("ll@x.in", "Landlord");
  const today = new Date();
  const due = Math.min(28, today.getUTCDate() + 2 > 28 ? 1 : today.getUTCDate() + 2);
  const end = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const bad = await call("POST", "/tenancies", { token: ll.token, body: { rent: 5000 } });
  assert.equal(bad.status, 400);
  const t = await call("POST", "/tenancies", { token: ll.token, body: { label: "Skyview 1204", tenant_name: "Tara", tenant_email: "tara@x.in", rent: 45000, currency: "INR", due_day: due, lease_end: end } });
  assert.equal(t.status, 200);
  const token = t.body.tenancy.repair_token;
  assert.match(token, /^[a-f0-9]{36}$/);
  const done = await runJobs(deps);
  assert.equal(done.renewal, 1);
  const items = (await inbox(ll)).items;
  assert.ok(items.some((x) => x.kind === "renewal"));
  if (done.rent) {
    assert.ok(items.some((x) => x.kind === "rent_due"));
    assert.ok(mail.sent.some((m) => m.email === "tara@x.in"));
  }
  assert.equal((await runJobs(deps)).renewal, 0);
  // Repair link: no sign-in needed.
  const info = await call("GET", `/repair/${token}`);
  assert.equal(info.body.label, "Skyview 1204");
  assert.equal((await call("POST", `/repair/${token}`, { body: { message: "x" } })).status, 400);
  assert.equal((await call("POST", `/repair/${token}`, { body: { message: "The AC is leaking water.", name: "Tara" } })).status, 200);
  assert.ok((await inbox(ll)).items.some((x) => x.kind === "repair" && /AC is leaking/.test(x.body)));
  assert.equal((await call("GET", `/repair/${"0".repeat(36)}`)).status, 404);
  // Only the owner sees and edits their tenancies.
  const other = await person("o2@x.in");
  assert.equal((await call("GET", "/tenancies", { token: other.token })).body.tenancies.length, 0);
  assert.equal((await call("DELETE", `/tenancies/${t.body.tenancy.id}`, { token: other.token })).status, 404);
  const nl = await call("PATCH", `/tenancies/${t.body.tenancy.id}`, { token: ll.token, body: { new_link: true } });
  assert.notEqual(nl.body.tenancy.repair_token, token);
  assert.equal((await call("GET", `/repair/${token}`)).status, 404);
});

test("safety flags and market badges", async () => {
  assert.deepEqual(textFlags({ description: "Owner abroad, send the deposit by Western Union and I'll courier the keys", kind: "listing" }), ["payment_red_flag"]);
  assert.ok(textFlags({ description: "Call me on +91 98765 43210", kind: "listing" }).includes("contact_in_text"));
  assert.ok(textFlags({ description: "Nice flat", kind: "listing", poster_type: "broker", city: "Dubai" }).includes("ad_permit_missing"));
  assert.deepEqual(textFlags({ description: "Nice flat. Permit 12345", kind: "listing", poster_type: "broker", city: "Dubai" }), []);
  const mk = (id, price, extra = {}) => ({ id, kind: "listing", status: "active", poster_type: "landlord", deal: "sale", city: "Pune", locality: "Kharadi", property_type: "apartment", currency: "INR", size_sqft: 1000, price, ...extra });
  const posts = [mk("a", 10000000), mk("b", 10000000), mk("c", 11000000), mk("d", 5000000), mk("e", 9000000, { first_price: 10000000 })];
  const info = marketInfo(posts);
  assert.equal(info.get("d").below_pct, 50);
  assert.equal(info.get("d").deal, true);
  assert.equal(info.get("e").cut_pct, 10);
  assert.equal(info.get("a").deal, false);
  assert.equal(matchesCriteria(posts[3], { deals_only: true, city: "pune" }, info.get("d")), true);
  assert.equal(matchesCriteria(posts[0], { deals_only: true, city: "pune" }, info.get("a")), false);
  assert.equal(listingFitsRequest(mk("z", 9000000, { bedrooms: 2 }), { kind: "request", status: "active", deal: "sale", city: "Pune", locality: "Kharadi", bedrooms: 3, price: 9500000 }), false);
});

test("scam warning reaches visitors; owner sees all their flags; admin flag list", async () => {
  const { call, person, post, feed } = setup();
  const owner = await person("o@x.in", "Owner");
  const admin = await person("admin@ps.in", "Admin");
  const l = await post(owner, sale({ description: "Owner abroad. Send the deposit before viewing, keys by courier. WhatsApp 98765 43210" }));
  const pub = (await feed(null)).find((x) => x.id === l.id);
  assert.equal(pub.warnings.length, 1);
  assert.match(pub.warnings[0], /scammers/);
  assert.equal((await feed(owner)).find((x) => x.id === l.id).warnings.length, 2);
  const flags = await call("GET", "/admin/flags", { token: admin.token });
  assert.equal(flags.body.posts.length, 1);
  assert.equal((await call("GET", "/admin/flags", { token: owner.token })).status, 403);
});

test("affordability maths", () => {
  const m = affordability({ mode: "mortgage", price: 1000000, down_payment_pct: 20, rate_pct: 5, years: 25 });
  assert.equal(m.loan, 800000);
  assert.equal(m.monthly_payment, 4677);
  const a = affordability({ mode: "afford", monthly_income: 30000, rate_pct: 5, years: 25, down_payment_pct: 20 });
  assert.equal(a.max_monthly_payment, 10500);
  assert.ok(a.max_price > 2000000 && a.max_price < 2500000);
  const y = affordability({ mode: "yield", price: 1000000, monthly_rent: 6000, annual_costs: 12000 });
  assert.equal(y.gross_yield_pct, 7.2);
  assert.equal(y.net_yield_pct, 6);
  const rb = affordability({ mode: "rent_vs_buy", price: 1500000, monthly_rent: 8000 });
  assert.ok(["buying", "renting"].includes(rb.cheaper));
  assert.equal(affordability({ mode: "mortgage" }).error, "Need the price.");
});

test("assistant: runs tools on live data and returns cards; alerts, drafts and descriptions", async () => {
  const { call, person, post, ai, store } = setup();
  const owner = await person("o@x.in", "Owner");
  const buyer = await person("b@x.in", "Bina");
  const l = await post(owner, sale());
  const say = (text) => ({ token: buyer.token, body: { messages: [{ role: "user", content: text }] } });
  assert.equal((await call("POST", "/assistant", { body: { messages: [{ role: "user", content: "hi" }] } })).status, 401);

  // Search: the AI asks for a tool, the server runs it, the AI answers.
  ai.chatQueue.push([{ type: "tool_use", id: "t1", name: "search_listings", input: { deal: "sale", city: "Gurugram", min_bedrooms: 3 } }]);
  ai.chatQueue.push([{ type: "text", text: "I found one 3 BHK in Skyview." }]);
  const r1 = await call("POST", "/assistant", say("3 bhk for sale in gurugram"));
  assert.equal(r1.status, 200);
  assert.equal(r1.body.text, "I found one 3 BHK in Skyview.");
  assert.deepEqual(r1.body.cards[0].ids, [l.id]);
  const toolResult = JSON.parse(ai.chatCalls[1].messages.at(-1).content[0].content);
  assert.equal(toolResult.total, 1);
  assert.equal(toolResult.results[0].id, l.id);
  assert.equal(JSON.stringify(toolResult).includes("9876543210"), false, "no phone numbers reach the AI");

  // Alert via the assistant.
  ai.chatQueue.push([{ type: "tool_use", id: "t2", name: "create_alert", input: { deal: "rent", city: "Gurugram", max_price: 50000 } }]);
  ai.chatQueue.push([{ type: "text", text: "Done." }]);
  const r2 = await call("POST", "/assistant", say("alert me for rentals under 50k"));
  assert.equal(r2.body.cards[0].type, "alert");
  assert.equal((await call("GET", "/alerts", { token: buyer.token })).body.alerts.length, 1);

  // Matchmaker: a request draft the buyer confirms.
  ai.chatQueue.push([{ type: "tool_use", id: "t3", name: "draft_request", input: { deal: "rent", bedrooms: 2, price: 40000, currency: "INR", locality: "Sector 7", city: "Gurugram", description: "2 BHK to rent." } }]);
  ai.chatQueue.push([{ type: "text", text: "Here's your request." }]);
  const r3 = await call("POST", "/assistant", say("I need a 2 bhk to rent"));
  const draft = r3.body.cards.find((c) => c.type === "draft").draft;
  assert.equal(draft.poster_type, "tenant");
  const posted = await call("POST", "/posts", { token: buyer.token, body: { draftId: draft.id } });
  assert.equal(posted.status, 200);

  // Listing writer: only for your own posts.
  ai.chatQueue.push([{ type: "tool_use", id: "t4", name: "propose_description", input: { post_id: l.id, description: "Bright 3 BHK." } }]);
  ai.chatQueue.push([{ type: "text", text: "Here." }]);
  const r4 = await call("POST", "/assistant", say("rewrite it"));
  assert.equal(r4.body.cards.length, 0);
  ai.chatQueue.push([{ type: "tool_use", id: "t5", name: "propose_description", input: { post_id: l.id, description: "Bright, airy 3 BHK in Skyview with park views." } }]);
  ai.chatQueue.push([{ type: "text", text: "Here's a better version." }]);
  const r5 = await call("POST", "/assistant", { token: owner.token, body: { messages: [{ role: "user", content: "improve my listing" }] } });
  assert.equal(r5.body.cards[0].type, "description");

  // Lead qualifier context: the listing's details are given to the AI.
  ai.chatQueue.push([{ type: "text", text: "Yes, it has 3 bedrooms." }]);
  await call("POST", "/assistant", { token: buyer.token, body: { messages: [{ role: "user", content: "how many rooms?" }], context: { post_id: l.id } } });
  assert.match(ai.chatCalls.at(-1).system, /opened the assistant from this listing/);
  assert.match(ai.chatCalls.at(-1).system, /Skyview/);

  // Enquiry card (the user sends it themselves).
  ai.chatQueue.push([{ type: "tool_use", id: "t6", name: "prepare_enquiry", input: { post_id: l.id, kind: "viewing", summary: "Cash buyer" } }]);
  ai.chatQueue.push([{ type: "text", text: "Tap send." }]);
  const r6 = await call("POST", "/assistant", say("book a viewing"));
  assert.equal(r6.body.cards[0].type, "enquiry");
  assert.equal((await store.rows("enquiries", {})).length, 0);
});

test("pin fixer and photos-to-listing in the posting chat", async () => {
  const { call, person, post, ai, store } = setup();
  const owner = await person("o@x.in", "Owner");
  const l = await post(owner, sale({ building: undefined, locality: "Sector 7", maps_link: "https://www.google.com/maps/place/Skyview/@28.4612345,77.0456789,17z" }));
  const row = store._posts.find((p) => p.id === l.id);
  assert.equal(row.lat, 28.4612345);
  assert.equal(row.precision, "building");
  assert.equal("maps_link" in row, false);
  assert.equal((await call("PATCH", `/posts/${l.id}`, { token: owner.token, body: { maps_link: "https://evil.example/@1,2" } })).status, 400);
  const ok = await call("PATCH", `/posts/${l.id}`, { token: owner.token, body: { maps_link: "https://www.google.com/maps?q=28.47,77.05" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(store._posts.find((p) => p.id === l.id).lng, 77.05);
  // Photos the user uploaded go to the AI as images; other URLs are dropped.
  const uid = store._users.get(owner.token).id;
  const mine = `${ENV.SUPABASE_URL}/storage/v1/object/public/photos/${uid}/a.jpg`;
  ai.queue.push({ text: "Nice kitchen. Where is it?", proposal: null });
  await call("POST", "/chat", { token: owner.token, body: { messages: [{ role: "user", content: "here are photos", images: [mine, "https://evil.example/x.jpg"] }] } });
  const sent = ai.calls.at(-1).at(-1).content;
  assert.equal(sent.filter((b) => b.type === "image").length, 1);
  assert.equal(sent[0].source.url, mine);
});
