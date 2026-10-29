// Public pages: /property/<id> and /sitemap.xml. They must show listings and never leak private data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { handlePublic } from "../netlify/lib/seo.mjs";
import { memoryStore, ENV } from "./fakes.mjs";

const SB = "https://abc.supabase.co";
const env = { ...ENV, SUPABASE_URL: SB, SITE_URL: "https://propertystalkers.com" };
const get = (path) => new Request("https://propertystalkers.com" + path);

async function setup() {
  const store = memoryStore();
  const base = { kind: "listing", poster_type: "landlord", status: "active", property_type: "apartment", currency: "AED", city: "Dubai", country: "United Arab Emirates", lat: 25.08, lng: 55.14, precision: "building", amenities: [] };
  const flat = await store.createPost({ ...base, user_id: "u1", deal: "rent", bedrooms: 2, price: 120000, building: "Marina Vista", locality: "Dubai Marina",
    unit_number: "1204", unit_key: "rent|marina vista|1204", size_sqft: 1100, contact_name: "Owner One", contact_phone: "971501111111",
    description: "Sea view <script>alert(1)</script> two bed.", photos: [SB + "/storage/v1/object/public/photos/a.jpg"], amenities: ["pool", "balcony"] });
  const dearer = await store.createPost({ ...base, user_id: "u2", poster_type: "broker", rera_number: "45530", deal: "rent", bedrooms: 2, price: 130000, building: "Marina Vista", locality: "Dubai Marina",
    unit_number: "1204", unit_key: "rent|marina vista|1204", contact_name: "Broker Two", contact_phone: "971502222222" });
  const villa = await store.createPost({ ...base, user_id: "u3", deal: "sale", property_type: "villa", bedrooms: 4, price: 5000000, locality: "Arabian Ranches", contact_name: "Owner Three", contact_phone: "971503333333" });
  const request = await store.createPost({ ...base, user_id: "u4", kind: "request", poster_type: "buyer", deal: "sale", bedrooms: 3, price: 3000000, locality: "JVC", contact_name: "Secret Buyer", contact_phone: "971504444444" });
  const sold = await store.createPost({ ...base, user_id: "u5", deal: "sale", bedrooms: 1, price: 900000, locality: "Dubai Marina", status: "removed", contact_name: "Gone", contact_phone: "971505555555" });
  return { store, deps: { store, env }, flat, dearer, villa, request, sold };
}

test("a listing page shows the property, its price and structured data", async () => {
  const { deps, flat } = await setup();
  const res = await handlePublic(get("/property/" + flat.id), deps);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>2 BHK apartment for rent in Marina Vista, Dubai Marina, Dubai · AED 120,000 a month \| Property Stalkers<\/title>/);
  assert.match(html, /og:image" content="https:\/\/propertystalkers.com\/sb\/storage\/v1\/object\/public\/photos\/a.jpg"/);
  assert.match(html, /rel="canonical" href="https:\/\/propertystalkers.com\/property\/[0-9a-f-]+"/);
  assert.match(html, /href="\/#p=/, "button opens the listing on the map");
  assert.match(html, /Pool<\/li><li>Balcony/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.equal(ld["@type"], "RealEstateListing");
  assert.equal(ld.offers.price, 120000);
  assert.equal(ld.offers.priceCurrency, "AED");
  assert.equal(ld.mainEntity["@type"], "Apartment");
  assert.equal(ld.mainEntity.numberOfBedrooms, 2);
  assert.equal(ld.mainEntity.floorSize.value, 1100);
});

test("listing pages never show phone numbers, unit numbers or raw script", async () => {
  const { deps, flat, villa } = await setup();
  for (const p of [flat, villa]) {
    const html = await (await handlePublic(get("/property/" + p.id), deps)).text();
    assert.doesNotMatch(html, /97150\d{7}/, "no phone number");
    assert.doesNotMatch(html, /1204/, "no unit number");
    assert.doesNotMatch(html, /<script>alert/, "description is escaped");
    assert.doesNotMatch(html, /Secret Buyer/, "requests never appear");
  }
});

test("requests, unknown ids and bad ids are not public pages", async () => {
  const { deps, request } = await setup();
  assert.equal((await handlePublic(get("/property/" + request.id), deps)).status, 404);
  assert.equal((await handlePublic(get("/property/" + randomUUID()), deps)).status, 404);
  assert.equal((await handlePublic(get("/property/not-an-id"), deps)).status, 404);
});

test("a removed listing says it's gone, isn't indexed, and suggests others nearby", async () => {
  const { deps, sold } = await setup();
  const res = await handlePublic(get("/property/" + sold.id), deps);
  assert.equal(res.status, 410);
  const html = await res.text();
  assert.match(html, /no longer listed/);
  assert.match(html, /noindex/);
  assert.match(html, /More in Dubai/);
});

test("a second listing of the same unit points search engines to the cheaper one", async () => {
  const { deps, flat, dearer } = await setup();
  const html = await (await handlePublic(get("/property/" + dearer.id), deps)).text();
  assert.match(html, new RegExp(`rel="canonical" href="https://propertystalkers.com/property/${flat.id}"`));
});

test("the sitemap lists what visitors see on the map, and nothing else", async () => {
  const { deps, flat, dearer, villa, request, sold } = await setup();
  const res = await handlePublic(get("/sitemap.xml"), deps);
  assert.match(res.headers.get("content-type"), /xml/);
  const xml = await res.text();
  assert.match(xml, /<loc>https:\/\/propertystalkers.com\/<\/loc>/);
  assert.ok(xml.includes(flat.id) && xml.includes(villa.id));
  assert.ok(!xml.includes(dearer.id), "only the cheapest listing of a unit");
  assert.ok(!xml.includes(request.id), "no requests");
  assert.ok(!xml.includes(sold.id), "no removed listings");
});

test("other paths are left alone", async () => {
  const { deps } = await setup();
  assert.equal(await handlePublic(get("/api/feed"), deps), null);
  assert.equal(await handlePublic(new Request("https://propertystalkers.com/sitemap.xml", { method: "POST" }), deps), null);
});
