// Map tools: search inside shapes drawn on the map, and exchange rates for showing prices in another currency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { parseArea, inArea, kmBetween, PIN_LIMIT } from "../netlify/lib/mapapi.mjs";
import { readRates, usdRates, forgetRates, PEGS } from "../netlify/lib/rates.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

async function setup(extra = {}) {
  const store = memoryStore();
  const deps = { store, ai: scriptedAI(), geo: tableGeo({}), env: ENV, ...extra };
  const call = async (...a) => { const r = await handle(req(...a), deps); return { status: r.status, body: await r.json(), headers: r.headers }; };
  const owner = store.addUser("own@x.in");
  const mk = (o) => store.createPost({ kind: "listing", poster_type: "landlord", status: "active", currency: "AED", city: "Dubai", deal: "sale", property_type: "apartment", price: 1000000, photos: [], user_id: owner.id, ...o });
  const marina = await mk({ lat: 25.08, lng: 55.14 });           // Dubai Marina
  const jlt = await mk({ lat: 25.07, lng: 55.145 });             // about 1.2 km away
  const downtown = await mk({ lat: 25.197, lng: 55.274 });       // about 19 km away
  const rental = await mk({ lat: 25.081, lng: 55.141, deal: "rent", price: 90000 });
  return { store, call, mk, marina, jlt, downtown, rental };
}
const view = "w=54.9&e=55.5&s=24.9&n=25.4&z=11";
const ids = (r) => r.body.pins.map((p) => p.id).sort();

test("shapes: reading them, and what counts as inside", () => {
  assert.deepEqual(parseArea("c:25.08,55.14,2"), [{ t: "c", lat: 25.08, lng: 55.14, km: 2 }]);
  assert.equal(parseArea("p:25,55;25.1,55;25.1,55.1|c:1,2,3").length, 2);
  for (const bad of ["", "c:25.08,55.14", "c:25.08,55.14,0", "c:95,55,2", "c:25,55,900", "p:25,55;25.1,55", "x:1,2,3", "c:a,b,c", "c:,,"]) assert.equal(parseArea(bad), null, bad);
  assert.equal(parseArea(Array(9).fill("c:25,55,1").join("|")).length, 5, "at most 5 shapes");
  assert.ok(Math.abs(kmBetween(25.08, 55.14, 25.197, 55.274) - 18.7) < 0.5);
  const square = parseArea("p:25,55;25,55.2;25.2,55.2;25.2,55");
  assert.ok(inArea(25.1, 55.1, square) && !inArea(25.3, 55.1, square) && !inArea(25.1, 55.3, square));
});

test("radius search: only listings inside the circle, on the map, in the list and in the count", async () => {
  const { call, marina, jlt, rental } = await setup();
  const all = await call("GET", `/map?${view}`);
  assert.equal(all.body.pins.length, 4);
  const near = await call("GET", `/map?${view}&area=c:25.08,55.14,2`);
  assert.equal(near.body.mode, "pins");
  assert.deepEqual(ids(near), [marina.id, jlt.id, rental.id].sort());
  assert.equal(near.body.total, 3);
  const tight = await call("GET", `/map?${view}&area=c:25.08,55.14,0.5`);
  assert.deepEqual(ids(tight), [marina.id, rental.id].sort());
  const list = await call("GET", `/map?${view}&area=c:25.08,55.14,2&mode=list&lim=2`);
  assert.equal(list.body.pins.length, 2);
  assert.equal(list.body.total, 3, "the total counts everything inside, not just the page sent");
  assert.equal((await call("GET", `/map?${view}&area=c:25.08,55.14,2&mode=count`)).body.total, 3);
  // Other filters still apply inside the shape
  assert.deepEqual(ids(await call("GET", `/map?${view}&area=c:25.08,55.14,2&deals=rent`)), [rental.id]);
});

test("drawn outline, several areas together, and an area that is off screen", async () => {
  const { call, marina, jlt, downtown, rental } = await setup();
  const loop = "p:25.06,55.13;25.06,55.16;25.09,55.16;25.09,55.13";
  assert.deepEqual(ids(await call("GET", `/map?${view}&area=${loop}`)), [marina.id, jlt.id, rental.id].sort());
  const both = await call("GET", `/map?${view}&area=${loop}|c:25.197,55.274,1`);
  assert.deepEqual(ids(both), [marina.id, jlt.id, downtown.id, rental.id].sort());
  const away = await call("GET", `/map?w=72&e=73&s=18.5&n=19.5&z=11&area=${loop}`);
  assert.deepEqual(away.body.pins, []);
  assert.equal((await call("GET", `/map?w=72&e=73&s=18.5&n=19.5&z=11&area=${loop}&mode=count`)).body.total, 0);
  // A shape that can't be read is ignored rather than hiding everything
  assert.equal((await call("GET", `/map?${view}&area=nonsense`)).body.pins.length, 4);
});

test("a busy area: dots (or counts) for what's inside the shape only", async () => {
  const { call, mk } = await setup();
  for (let i = 0; i < PIN_LIMIT + 20; i++) await mk({ lat: 25.2 + (i % 20) * 0.0005, lng: 55.27 + Math.floor(i / 20) * 0.0005 });
  const circle = "c:25.205,55.274,3";
  const dots = await call("GET", `/map?${view}&area=${circle}&dots=1`);
  assert.equal(dots.body.mode, "dots");
  assert.equal(dots.body.total, PIN_LIMIT + 21, "the busy block plus the one Downtown listing; the Marina ones are outside");
  const counts = await call("GET", `/map?${view}&area=${circle}`);
  assert.equal(counts.body.mode, "clusters");
  assert.equal(counts.body.clusters.reduce((t, c) => t + c.n, 0), PIN_LIMIT + 21);
  // Zoomed far out, a small area still shows its pins
  const far = await call("GET", `/map?w=40&e=70&s=10&n=40&z=5&area=c:25.08,55.14,2`);
  assert.equal(far.body.mode, "pins");
  assert.equal(far.body.pins.length, 3);
});

test("exchange rates: both answer shapes are read, and junk is left out", () => {
  assert.deepEqual(readRates([{ date: "2026-11-12", base: "USD", quote: "EUR", rate: 0.9 }, { base: "USD", quote: "inr", rate: "88.5" }, { quote: "BAD1", rate: 2 }, { quote: "JPY", rate: -1 }, null]), { EUR: 0.9, INR: 88.5 });
  assert.deepEqual(readRates({ base: "USD", rates: { EUR: 0.9, GBP: 0.78, XX: 1 } }), { EUR: 0.9, GBP: 0.78 });
  assert.deepEqual(readRates("nope"), {});
});

test("exchange rates: looked up once and remembered; fixed Gulf rates fill in; a failed lookup still answers", async () => {
  forgetRates();
  let calls = 0;
  const rows = ["EUR", "GBP", "INR", "CNY", "RUB", "JPY", "CAD", "AUD", "CHF", "PKR"].map((q, i) => ({ base: "USD", quote: q, rate: 1 + i }));
  const { call } = await setup({ ratesJson: async () => { calls++; return rows; } });
  const a = await call("GET", "/rates");
  assert.equal(a.status, 200);
  assert.equal(a.body.live, true);
  assert.equal(a.body.rates.USD, 1);
  assert.equal(a.body.rates.INR, 3);
  assert.equal(a.body.rates.AED, PEGS.AED, "the dirham is fixed to the dollar");
  assert.match(a.headers.get("cache-control"), /max-age=3600/);
  await call("GET", "/rates");
  assert.equal(calls, 1, "remembered, not looked up again");
  forgetRates();
  const down = await usdRates(async () => { throw new Error("down"); });
  assert.equal(down.live, false);
  assert.deepEqual(Object.keys(down.rates).sort(), [...Object.keys(PEGS), "USD"].sort());
  // First source empty, second (older shape) answers
  forgetRates();
  let n = 0;
  const second = await usdRates(async () => (++n === 1 ? [] : { rates: Object.fromEntries(rows.map((r) => [r.quote, r.rate])) }));
  assert.equal(second.live, true);
  assert.equal(n, 2);
  forgetRates();
});
