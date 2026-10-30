// Area air quality and noise on listings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usAqi, airLevel, scoreNoise, distToLine, airKey, noiseKey, attachEnv, fillEnv, AIR_DAILY_CAP } from "../netlify/lib/envq.mjs";
import { handle } from "../netlify/lib/handler.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

test("US-style AQI from fine particles and dust (the worse one wins)", () => {
  assert.equal(usAqi(5, 20), 28);           // PM2.5 5 µg/m³ -> 28
  assert.equal(usAqi(9, 0), 50);
  assert.equal(usAqi(12, 30), 56);          // PM2.5 just over the good line
  assert.equal(usAqi(10, 200), 123);        // dusty day: PM10 decides
  assert.equal(usAqi(null, null), null);
  assert.deepEqual(airLevel(42), { lvl: 1, label: "Good" });
  assert.equal(airLevel(123).lvl, 3);
  assert.equal(airLevel(180).label, "Unhealthy");
});

test("distance to a road line", () => {
  // A north-south road 0.001° (~100 m) east of the point.
  const d = distToLine(25.08, 55.14, [{ lat: 25.07, lon: 55.141 }, { lat: 25.09, lon: 55.141 }]);
  assert.ok(d > 95 && d < 105, String(d));
});

test("noise: highway and metro close by is Busy or Noisy, with plain reasons; nothing nearby is Quiet", () => {
  const lat = 25.08, lng = 55.14;
  const loud = scoreNoise(lat, lng, [
    { type: "way", tags: { highway: "trunk", name: "Sheikh Zayed Road" }, geometry: [{ lat: 25.07, lon: 55.1409 }, { lat: 25.09, lon: 55.1409 }] },
    { type: "way", tags: { railway: "subway", name: "Red Line" }, geometry: [{ lat: 25.07, lon: 55.1405 }, { lat: 25.09, lon: 55.1405 }] },
    { type: "node", tags: { amenity: "bar" }, lat: 25.0801, lon: 55.1401 }
  ]);
  assert.ok(loud.lvl >= 3, JSON.stringify(loud));
  assert.match(loud.why[0], /Sheikh Zayed Road/);
  assert.ok(loud.why.some((w) => /Red Line/.test(w)));
  const calm = scoreNoise(lat, lng, []);
  assert.deepEqual([calm.lvl, calm.label, calm.why], [1, "Quiet", []]);
});

test("cache: first view schedules lookups, later views show air and noise; air lookups are capped per day", async () => {
  const store = memoryStore();
  const calls = { air: 0, noise: 0 };
  const envq = { air: async () => { calls.air++; return { aqi: 64, lvl: 2, label: "Moderate", main: "dust (PM10)" }; },
    noise: async () => { calls.noise++; return { score: 20, lvl: 2, label: "Moderate", why: ["about 150 m from a main road"] }; } };
  const pins = [{ id: "a", lat: 25.08, lng: 55.14 }, { id: "b", lat: 25.081, lng: 55.141 }];
  const miss = await attachEnv(store, pins);
  assert.equal(pins[0].env, undefined);
  assert.ok(miss.includes(airKey(25.08, 55.14)) && miss.includes(noiseKey(25.08, 55.14)));
  assert.equal(new Set(miss.filter((k) => k.startsWith("air:"))).size, 1, "nearby listings share one air lookup");
  await fillEnv(store, envq, miss);
  const again = [{ id: "a", lat: 25.08, lng: 55.14 }];
  assert.deepEqual(await attachEnv(store, again), [], "nothing left to look up");
  assert.equal(again[0].env.air.aqi, 64);
  assert.equal(again[0].env.noise.label, "Moderate");
  // daily cap
  const today = "budget:" + new Date().toISOString().slice(0, 10);
  await store.update("area_env", { key: today }, { data: { n: AIR_DAILY_CAP } });
  const before = calls.air;
  await fillEnv(store, envq, [airKey(10, 10)]);
  assert.equal(calls.air, before, "no air lookups once today's cap is used");
});

test("a failed lookup is not shown and is retried later, not on every view", async () => {
  const store = memoryStore();
  const envq = { air: async () => { throw new Error("down"); }, noise: async () => { throw new Error("down"); } };
  const pins = [{ id: "a", lat: 1, lng: 1 }];
  await fillEnv(store, envq, await attachEnv(store, pins));
  const p2 = [{ id: "a", lat: 1, lng: 1 }];
  assert.deepEqual(await attachEnv(store, p2), []);
  assert.equal(p2[0].env, undefined);
});

test("map pins and listing details carry area air and noise", async () => {
  const store = memoryStore();
  const envq = { air: async () => ({ aqi: 42, lvl: 1, label: "Good", main: "fine particles (PM2.5)" }), noise: async () => ({ score: 5, lvl: 1, label: "Quiet", why: [] }) };
  const deps = { store, ai: scriptedAI(), geo: tableGeo({}), env: { ...ENV, MAP_PIN_MIN_ZOOM: "0" }, envq };
  const u = store.addUser("o@x.in");
  const p = await store.createPost({ user_id: u.id, kind: "listing", poster_type: "landlord", deal: "sale", property_type: "apartment", price: 100, currency: "AED", city: "Dubai", lat: 25.08, lng: 55.14, status: "active", photos: [] });
  const call = async (path) => (await handle(req("GET", path), deps)).json();
  const area = "w=55&s=25&e=55.3&n=25.2&z=12&deals=sale";
  await call(`/map?${area}`);                       // first view: looks the area up after the reply
  const pin = (await call(`/map?${area}`)).pins.find((x) => x.id === p.id);
  assert.deepEqual([pin.env.air.aqi, pin.env.noise.label], [42, "Quiet"]);
  const full = (await call(`/posts/${p.id}`)).post;
  assert.equal(full.env.air.label, "Good");
});

test("noise tries the next OpenStreetMap server when one is busy", async () => {
  const { makeEnvq, OVERPASS } = await import("../netlify/lib/envq.mjs");
  const hit = [];
  const fetchImpl = async (url) => {
    hit.push(url);
    if (url === OVERPASS[0]) return new Response("busy", { status: 504 });
    return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = await makeEnvq({ airKey: "", fetchImpl }).noise(25.08, 55.14);
  assert.equal(r.label, "Quiet");
  assert.deepEqual(hit, OVERPASS.slice(0, 2));
});
