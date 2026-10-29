// Background jobs. There is no scheduler on the free hosting plan, so these run on normal site traffic,
// at most once every few hours: stale-listing checks, rent and renewal reminders, viewing reminders.
import { notifyMany } from "./notify.mjs";
import { postTitle } from "./events.mjs";

const DAY = 86400000;
const EVERY = 4 * 3600000;
const STALE_AFTER = 30 * DAY;
const EXPIRE_AFTER = 7 * DAY;
let lastLocalCheck = 0;

/** Cheap check on each feed request; does the work only when due. */
export async function maybeRunJobs(deps, now = Date.now()) {
  if (now - lastLocalCheck < 10 * 60000) return null;
  lastLocalCheck = now;
  const [row] = await deps.store.rows("site_jobs", { name: "daily" });
  if (row && now - new Date(row.last_run).getTime() < EVERY) return null;
  return runJobs(deps, now);
}

export async function runJobs(deps, now = Date.now()) {
  const { store, mail } = deps;
  const iso = (t) => new Date(t).toISOString();
  const [row] = await store.rows("site_jobs", { name: "daily" });
  if (row) await store.update("site_jobs", { name: "daily" }, { last_run: iso(now) });
  else await store.insert("site_jobs", { name: "daily", last_run: iso(now) });

  const notes = [];
  const done = { stale: 0, expired: 0, rent: 0, renewal: 0, viewings: 0 };

  // 1. Listings not confirmed for 30 days: ask "still available?"
  const stale = (await store.rows("posts", { status: "active", kind: "listing", confirmed_at: { lt: iso(now - STALE_AFTER) }, stale_notified_at: null }, { limit: 20 }))
    .filter((p) => p.poster_type !== "developer");
  if (stale.length) {
    await store.update("posts", { id: { in: stale.map((p) => p.id) } }, { stale_notified_at: iso(now) });
    for (const p of stale) notes.push({ user_id: p.user_id, kind: "stale", post_id: p.id,
      title: `Is your ${postTitle(p)} still available?`, body: "Tap to confirm it's still available, or remove it. Unconfirmed listings are taken off the map after 7 days." });
    done.stale = stale.length;
  }

  // 2. Asked 7+ days ago and still not confirmed: take it off the map.
  const expired = (await store.rows("posts", { status: "active", kind: "listing", stale_notified_at: { lt: iso(now - EXPIRE_AFTER) } }, { limit: 20 }))
    .filter((p) => new Date(p.confirmed_at).getTime() < new Date(p.stale_notified_at).getTime());
  if (expired.length) {
    await store.update("posts", { id: { in: expired.map((p) => p.id) } }, { status: "expired" });
    for (const p of expired) notes.push({ user_id: p.user_id, kind: "expired", post_id: p.id,
      title: `Your ${postTitle(p)} was taken off the map`, body: "It wasn't confirmed as still available. Open it and confirm to put it back." });
    done.expired = expired.length;
  }

  // 3. Rent due within 3 days, and leases ending within 60 days.
  const tenancies = await store.rows("tenancies", {}, { limit: 500 });
  const tenantMails = [];
  const today = new Date(now);
  const rentGroups = new Map();
  const renewalIds = [];
  for (const t of tenancies) {
    if (t.due_day) {
      let due = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), t.due_day));
      if (due.getTime() < now - DAY) due = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, t.due_day));
      const days = Math.ceil((due.getTime() - now) / DAY);
      const month = due.toISOString().slice(0, 7);
      if (days <= 3 && t.rent_reminded_for !== month) {
        const when = due.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        notes.push({ user_id: t.user_id, kind: "rent_due", ref_id: t.id,
          title: `Rent due ${when}: ${t.label}`, body: `${t.tenant_name || "Your tenant"} · ${t.currency || ""} ${t.rent ? Number(t.rent).toLocaleString("en-US") : ""}`.trim() });
        if (t.tenant_email) tenantMails.push({ email: t.tenant_email, name: t.tenant_name, title: `Rent reminder: due ${when}`,
          body: `This is a friendly reminder that rent for ${t.label}${t.rent ? ` (${t.currency || ""} ${Number(t.rent).toLocaleString("en-US")})` : ""} is due on ${when}.` });
        if (!rentGroups.has(month)) rentGroups.set(month, []);
        rentGroups.get(month).push(t.id);
        done.rent++;
      }
    }
    if (t.lease_end && !t.renewal_reminded) {
      const days = Math.ceil((new Date(t.lease_end).getTime() - now) / DAY);
      if (days <= 60 && days >= -1) {
        notes.push({ user_id: t.user_id, kind: "renewal", ref_id: t.id,
          title: `Lease ends in ${Math.max(days, 0)} days: ${t.label}`, body: `Time to talk to ${t.tenant_name || "your tenant"} about renewing, or to list it for rent again.` });
        renewalIds.push(t.id);
        done.renewal++;
      }
    }
  }
  for (const [month, ids] of rentGroups) await store.update("tenancies", { id: { in: ids } }, { rent_reminded_for: month });
  if (renewalIds.length) await store.update("tenancies", { id: { in: renewalIds } }, { renewal_reminded: true });

  // 4. Accepted viewings in the next 24 hours.
  const viewings = await store.rows("enquiries", { kind: "viewing", status: "accepted", reminded: false, slot: { gte: iso(now), lte: iso(now + DAY) } }, { limit: 50 });
  if (viewings.length) {
    await store.update("enquiries", { id: { in: viewings.map((v) => v.id) } }, { reminded: true });
    for (const v of viewings) {
      const when = new Date(v.slot).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai", timeZoneName: "short" });
      for (const u of [v.from_user, v.to_user]) notes.push({ user_id: u, kind: "viewing_reminder", post_id: v.post_id, ref_id: v.id, title: `Viewing reminder: ${when}`, body: "Open the listing for the address and contact details." });
    }
    done.viewings = viewings.length;
  }

  await notifyMany(deps, notes);
  if (mail && tenantMails.length) { try { await mail.send(tenantMails); } catch (e) { console.error(e); } }
  return done;
}
