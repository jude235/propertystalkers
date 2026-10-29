// Checks the real AI and Google modules build correct requests and read responses correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAI } from "../netlify/lib/ai.mjs";
import { makeGeo, precisionOf } from "../netlify/lib/geo.mjs";

test("AI request shape and tool parsing", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      content: [
        { type: "text", text: "Here's your draft." },
        { type: "tool_use", id: "t1", name: "propose_post", input: { poster_type: "landlord", city: "Pune" } }
      ],
      stop_reason: "tool_use"
    }), { status: 200 });
  };
  const ai = makeAI({ apiKey: "k", fetchImpl });
  const r = await ai.converse([{ role: "user", content: "hi" }]);
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.init.headers["x-api-key"], "k");
  assert.equal(sent.body.model, "claude-haiku-5-5");
  assert.equal(sent.body.tools[0].name, "propose_post");
  assert.deepEqual(r, { text: "Here's your draft.", proposal: { poster_type: "landlord", city: "Pune" }, stopReason: "tool_use" });
  assert.equal(sent.body.max_tokens, 1500);

  const bad = makeAI({ apiKey: "k", fetchImpl: async () => new Response("nope", { status: 401 }) });
  await assert.rejects(bad.converse([{ role: "user", content: "x" }]), /401/);
});

test("geocoding: building, falls back to sector, rejects city-only", async () => {
  const answers = {
    "Skyview, Sector 7, Gurugram": { status: "OK", results: [{ types: ["premise"], place_id: "P1", formatted_address: "Skyview, Gurugram", geometry: { location: { lat: 1, lng: 2 } } }] },
    "Ghost Tower, Sector 9, Gurugram": { status: "OK", results: [{ types: ["locality", "political"], place_id: "C", formatted_address: "Gurugram", geometry: { location: { lat: 0, lng: 0 } } }] },
    "Sector 9, Gurugram": { status: "OK", results: [{ types: ["sublocality_level_1", "political"], place_id: "S9", formatted_address: "Sector 9, Gurugram", geometry: { location: { lat: 3, lng: 4 } } }] },
    "Atlantis": { status: "ZERO_RESULTS", results: [] }
  };
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(u);
    const address = new URL(u).searchParams.get("address");
    return new Response(JSON.stringify(answers[address] || { status: "ZERO_RESULTS", results: [] }));
  };
  const geo = makeGeo({ apiKey: "g", fetchImpl });
  assert.deepEqual(await geo.locate({ building: "Skyview", locality: "Sector 7", city: "Gurugram" }),
    { lat: 1, lng: 2, precision: "building", address: "Skyview, Gurugram", place_id: "P1" });
  assert.doesNotMatch(urls[0], /components=/);
  assert.deepEqual(await geo.locate({ building: "Ghost Tower", locality: "Sector 9", city: "Gurugram" }),
    { lat: 3, lng: 4, precision: "area", address: "Sector 9, Gurugram", place_id: null });
  assert.equal(await geo.locate({ building: null, locality: null, city: "Atlantis" }), null);
  assert.equal(precisionOf({ types: ["locality"] }), "city");

  const denied = makeGeo({ apiKey: "g", fetchImpl: async () => new Response(JSON.stringify({ status: "REQUEST_DENIED", error_message: "bad key" })) });
  await assert.rejects(denied.locate({ locality: "X", city: "Y" }), /REQUEST_DENIED/);
});

test("pin from a Google Maps short link follows the redirect", async () => {
  const fetchImpl = async (u) => {
    if (u === "https://maps.app.goo.gl/abc") return new Response(null, { status: 302, headers: { location: "https://www.google.com/maps/place/X/data=!3d25.0801!4d55.1402" } });
    throw new Error("unexpected " + u);
  };
  const geo = makeGeo({ apiKey: "k", fetchImpl });
  assert.deepEqual(await geo.pinFromLink("https://maps.app.goo.gl/abc"), { lat: 25.0801, lng: 55.1402 });
  assert.deepEqual(await geo.pinFromLink("https://www.google.com/maps/@25.2,55.3,15z"), { lat: 25.2, lng: 55.3 });
});
