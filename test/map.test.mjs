// The fast map: only what's in view, pins when zoomed in, counts when zoomed out, never private data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { mapFilter, PIN_LIMIT } from "../netlify/lib/mapapi.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

async function setup() {
  const store = memoryStore();
  const deps = { store, ai: scriptedAI(), geo: tableGeo({}), env: ENV };
  const call = async (...a) => { const r = await handle(req(...a), deps); return { status: r.status, body: await r.json() }; };
  const owner = store.addUser("own@x.in");
  const base = { kind: "listing", poster_type: "landlord", status: "active", currency: "AED", city: "Dubai", locality: "JLT", precision: "area",
    photos: ["https://x/p1.jpg", "https://x/p2.jpg"], contact_name: "Owner", contact_phone: "971501111111", description: "Long description here", unit_number: "77" };
  const sale = await store.createPost({ ...base, user_id: owner.id, deal: "sale", price: 1000000, lat: 25.07, lng: 55.14, property_type: "apartment", bedrooms: 2 });
  const rent = await store.createPost({ ...base, user_id: owner.id, deal: "rent", price: 90000, lat: 25.071, lng: 55.141, property_type: "office" });
  const far = await store.createPost({ ...base, user_id: owner.id, deal: "sale", price: 500000, lat: 19.07, lng: 72.88, city: "Mumbai" });
  const dev = await store.createPost({ ...base, user_id: owner.id, deal: "sale", poster_type: "developer", company: "Dev Co", price: 2000000, lat: 25.072, lng: 55.142 });
  const req1 = await store.createPost({ ...base, user_id: owner.id, kind: "request", poster_type: "buyer", deal: "sale", price: 900000, lat: 25.07, lng: 55.14 });
  return { store, call, owner, sale, rent, far, dev, req1 };
}
const area = "w=55.0&e=55.3&s=25.0&n=25.2&z=13";

test("only listings inside the visible area are sent", async () => {
  const { call, sale, rent, far } = await setup();
  const r = await call("GET", `/map?${area}&deals=sale,rent`);
  assert.equal(r.body.mode, "pins");
  const ids = r.body.pins.map((p) => p.id);
  assert.ok(ids.includes(sale.id) && ids.includes(rent.id));
  assert.ok(!ids.includes(far.id), "Mumbai is off screen");
});

test("pins are lean: no description, contact, phone or unit number; photo links plus a count", async () => {
  const { call, sale } = await setup();
  const pin = (await call("GET", `/map?${area}&deals=sale`)).body.pins.find((p) => p.id === sale.id);
  for (const k of ["description", "contact_phone", "contact_name", "unit_number", "user_id", "unit_key"]) assert.equal(pin[k], undefined, k);
  assert.equal(pin.photo, "https://x/p1.jpg");
  assert.deepEqual(pin.photos, ["https://x/p1.jpg", "https://x/p2.jpg"]);
  assert.equal(pin.nphotos, 2);
});

test("chips add up: every chip adds its listings, none hides another's", async () => {
  const { call, sale, rent, dev } = await setup();
  const ids = async (q) => (await call("GET", `/map?${area}&${q}`)).body.pins.map((p) => p.id).sort();
  assert.deepEqual(await ids("deals=sale"), [sale.id, dev.id].sort());
  assert.deepEqual(await ids("deals=sale,rent"), [sale.id, rent.id, dev.id].sort());
  assert.deepEqual(await ids("deals=rent&cats=commercial"), [rent.id]);
  assert.deepEqual(await ids("deals=sale&cats=project"), [sale.id, dev.id].sort(), "sale listings stay when New projects is added");
  assert.deepEqual(await ids("cats=project"), [dev.id]);
  assert.deepEqual(await ids("deals=stay&cats=project"), [dev.id], "a chip with nothing in view doesn't hide the others");
  assert.deepEqual(await ids("deals=sale&types=apartment&beds=2"), [sale.id]);
  assert.deepEqual(await ids("deals=sale&pmax=1500000"), [sale.id]);
});

test("requests in view only for licensed brokers", async () => {
  const { call, store, req1 } = await setup();
  assert.equal((await call("GET", `/map?${area}&kind=request`)).body.pins.length, 0);
  const b = store.addUser("brk@x.in");
  await call("POST", "/me", { token: b.token, body: { name: "Broker", phone: "+971501234567" } });
  await call("POST", "/me/role", { token: b.token, body: { role: "broker", licence: "BRN 12345" } });
  assert.deepEqual((await call("GET", `/map?${area}&kind=request`, { token: b.token })).body.pins.map((p) => p.id), [req1.id]);
});

test("zoomed out, or too many pins: counts per area instead", async () => {
  const { call, store, owner } = await setup();
  const world = (await call("GET", "/map?w=-170&e=170&s=-60&n=70&z=3&deals=sale")).body;
  assert.equal(world.mode, "clusters");
  assert.equal(world.total, 3);
  for (let i = 0; i < PIN_LIMIT + 5; i++) await store.createPost({ kind: "listing", poster_type: "landlord", status: "active", deal: "sale", price: 1, lat: 25.05 + i / 1e5, lng: 55.1, user_id: owner.id });
  const busy = (await call("GET", `/map?${area}&deals=sale`)).body;
  assert.equal(busy.mode, "clusters");
  assert.equal(busy.total, PIN_LIMIT + 5 + 2);
  const list = (await call("GET", `/map?${area}&deals=sale&mode=list&lim=10`)).body;
  assert.equal(list.pins.length, 10, "the list still gets the newest few");
  assert.equal(list.total, PIN_LIMIT + 7);
});

test("a view across the date line works", async () => {
  const { call, store, owner } = await setup();
  const fiji = await store.createPost({ kind: "listing", poster_type: "landlord", status: "active", deal: "sale", price: 1, lat: -17.7, lng: 178.0, user_id: owner.id });
  const r = (await call("GET", "/map?w=170&e=-170&s=-30&n=0&z=10&deals=sale")).body;
  assert.deepEqual(r.pins.map((p) => p.id), [fiji.id]);
});

test("bad areas are refused", async () => {
  const { call } = await setup();
  assert.equal((await call("GET", "/map?w=55&e=56&s=26&n=25")).status, 400);
  assert.equal((await call("GET", "/map?w=abc")).status, 400);
  assert.equal(mapFilter(new URL("https://x/map?w=1&e=2&s=1&n=2&deals=hack,sale&by=admin"), null).deals.join(), "sale");
});

test("opening a listing gets the full details", async () => {
  const { call, sale } = await setup();
  const p = (await call("GET", `/posts/${sale.id}`)).body.post;
  assert.equal(p.description, "Long description here");
  assert.equal(p.photos.length, 2);
  assert.equal(p.unit_number, null, "still private");
  assert.equal((await call("GET", "/posts/00000000-0000-4000-8000-000000000000")).status, 404);
});

test("search, batch and shortlist return lean pins", async () => {
  const { call, store, sale, rent, far } = await setup();
  assert.deepEqual((await call("GET", "/search?q=mumbai")).body.pins.map((p) => p.id), [far.id]);
  assert.deepEqual((await call("POST", "/posts/batch", { body: { ids: [rent.id, sale.id, "junk"] } })).body.pins.map((p) => p.id), [rent.id, sale.id]);
  const me = store.addUser("me@x.in");
  await call("POST", "/me", { token: me.token, body: { name: "Me", phone: "+971501234567" } });
  await call("POST", `/posts/${sale.id}/watch`, { token: me.token });
  const sl = (await call("GET", "/shortlist", { token: me.token })).body.pins;
  assert.equal(sl.length, 1);
  assert.equal(sl[0].watched, true);
  assert.deepEqual((await call("GET", "/me", { token: me.token })).body.counts, { shortlist: 1, hidden: 0, requests: 0 });
});

test("hidden listings stay off this person's map", async () => {
  const { call, store, sale } = await setup();
  const me = store.addUser("hid@x.in");
  await call("POST", "/me", { token: me.token, body: { name: "Me", phone: "+971501234567" } });
  await call("POST", `/posts/${sale.id}/hide`, { token: me.token });
  const mine = (await call("GET", `/map?${area}&deals=sale`, { token: me.token })).body.pins.map((p) => p.id);
  assert.ok(!mine.includes(sale.id));
  const anon = (await call("GET", `/map?${area}&deals=sale`)).body.pins.map((p) => p.id);
  assert.ok(anon.includes(sale.id));
});

test("zoomed out, the new look gets one tiny dot per listing (position and colour code only)", async () => {
  const { call, sale, rent, dev } = await setup();
  const r = await call("GET", "/map?w=40&s=0&e=100&n=40&z=4&deals=sale,rent&cats=project&dots=1");
  assert.equal(r.body.mode, "dots");
  const byPos = new Map(r.body.dots.map((d) => [d[0] + "," + d[1], d[2]]));
  assert.equal(byPos.get(sale.lat + "," + sale.lng), "s");
  assert.equal(byPos.get(rent.lat + "," + rent.lng), "r");
  assert.equal(byPos.get(dev.lat + "," + dev.lng), "n");
  assert.ok(r.body.dots.every((d) => d.length === 3), "nothing but position and colour");
  const old = await call("GET", "/map?w=40&s=0&e=100&n=40&z=4&deals=sale");
  assert.equal(old.body.mode, "clusters", "the current look still gets counts");
});
