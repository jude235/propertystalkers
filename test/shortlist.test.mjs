// Shortlist (swipe right) and hide (swipe left).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../netlify/lib/handler.mjs";
import { memoryStore, scriptedAI, tableGeo, ENV, req } from "./fakes.mjs";

async function setup() {
  const store = memoryStore();
  const deps = { store, ai: scriptedAI(), geo: tableGeo({}), env: ENV };
  const call = async (...a) => { const r = await handle(req(...a), deps); return { status: r.status, body: await r.json() }; };
  const owner = store.addUser("own@x.in");
  const me = store.addUser("me@x.in");
  await call("POST", "/me", { token: me.token, body: { name: "Me", phone: "+971501234567" } });
  const base = { kind: "listing", poster_type: "landlord", deal: "rent", status: "active", currency: "AED", city: "Dubai", locality: "JLT", lat: 25.07, lng: 55.14, precision: "area", photos: [], contact_name: "O", contact_phone: "971500000001" };
  const a = await store.createPost({ ...base, user_id: owner.id, price: 90000 });
  const b = await store.createPost({ ...base, user_id: owner.id, price: 95000 });
  const mine = await store.createPost({ ...base, user_id: me.id, price: 80000 });
  return { store, call, me, a, b, mine };
}

test("swipe left hides a listing for that person only, and it comes back when cleared", async () => {
  const { call, me, a, b } = await setup();
  assert.equal((await call("POST", `/posts/${a.id}/hide`, { token: me.token })).body.hidden, true);
  const feed = (await call("GET", "/feed", { token: me.token })).body.posts;
  assert.equal(feed.find((p) => p.id === a.id).hidden, true);
  assert.equal(feed.find((p) => p.id === b.id).hidden, false);
  const anon = (await call("GET", "/feed")).body.posts;
  assert.equal(anon.find((p) => p.id === a.id).hidden, false, "other people still see it");
  const list = (await call("GET", "/hidden", { token: me.token })).body.hidden;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, a.id);
  assert.equal(list[0].contact_phone, undefined, "no contact details in the hidden list");
  await call("DELETE", "/hidden", { token: me.token });
  assert.equal((await call("GET", "/hidden", { token: me.token })).body.hidden.length, 0);
});

test("unhide one listing", async () => {
  const { call, me, a } = await setup();
  await call("POST", `/posts/${a.id}/hide`, { token: me.token });
  await call("DELETE", `/posts/${a.id}/hide`, { token: me.token });
  assert.equal((await call("GET", "/feed", { token: me.token })).body.posts.find((p) => p.id === a.id).hidden, false);
});

test("swipe right shortlists (and watches the price); hiding removes it from the shortlist", async () => {
  const { call, me, a } = await setup();
  await call("POST", `/posts/${a.id}/watch`, { token: me.token });
  assert.equal((await call("GET", "/feed", { token: me.token })).body.posts.find((p) => p.id === a.id).watched, true);
  await call("POST", `/posts/${a.id}/hide`, { token: me.token });
  const p = (await call("GET", "/feed", { token: me.token })).body.posts.find((x) => x.id === a.id);
  assert.equal(p.watched, false);
  assert.equal(p.hidden, true);
});

test("you can't shortlist or hide your own listing", async () => {
  const { call, me, mine } = await setup();
  assert.equal((await call("POST", `/posts/${mine.id}/watch`, { token: me.token })).status, 400);
  assert.equal((await call("POST", `/posts/${mine.id}/hide`, { token: me.token })).status, 400);
});

test("what was saved on the device before signing in is kept", async () => {
  const { call, me, a, b, mine } = await setup();
  const r = await call("POST", "/saved/merge", { token: me.token, body: { shortlist: [a.id, "junk", mine.id], hidden: [b.id, b.id] } });
  assert.deepEqual(r.body, { shortlisted: 1, hidden: 1 });
  const feed = (await call("GET", "/feed", { token: me.token })).body.posts;
  assert.equal(feed.find((p) => p.id === a.id).watched, true);
  assert.equal(feed.find((p) => p.id === b.id).hidden, true);
});

test("hiding needs sign-in", async () => {
  const { call, a } = await setup();
  assert.equal((await call("POST", `/posts/${a.id}/hide`)).status, 401);
});
