// Notifications: always saved for the in-site bell; also emailed through Brevo when a key is set.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function makeMailer({ apiKey, from = "alerts@propertystalkers.com", site = "https://propertystalkers.com", fetchImpl = fetch }) {
  if (!apiKey) return null;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#14231d">
    <div style="background:#0f3b2e;color:#f3ebdd;padding:14px 18px;font-size:18px">property<b style="color:#b8894a">stalkers</b></div>
    <div style="padding:18px;border:1px solid #e6dccb;border-top:0">
      <h2 style="font-size:18px;margin:0 0 10px">{{params.title}}</h2>
      <p style="font-size:15px;line-height:1.5;margin:0 0 18px">{{params.body}}</p>
      <a href="{{params.link}}" style="background:#0f3b2e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Property Stalkers</a>
      <p style="font-size:12px;color:#7a7266;margin-top:22px">You get these emails because you use Property Stalkers. You can turn them off in My profile.</p>
    </div></div>`;
  return {
    /** messages: [{ email, name, title, body, link }] — sent in one request. */
    async send(messages) {
      if (!messages.length) return;
      const res = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": apiKey, accept: "application/json" },
        body: JSON.stringify({
          sender: { name: "Property Stalkers", email: from },
          subject: "{{params.title}}",
          htmlContent: html,
          messageVersions: messages.slice(0, 50).map((m) => ({
            to: [{ email: m.email, name: m.name || undefined }],
            params: { title: esc(m.title), body: esc(m.body || ""), link: m.link || site }
          }))
        })
      });
      if (!res.ok) console.error("Email failed", res.status, await res.text());
    }
  };
}

/**
 * items: [{ user_id, kind, title, body, post_id?, ref_id? }]
 * One insert for all of them, one profile lookup and one email request: cheap enough to run inside a request.
 */
export async function notifyMany(deps, items) {
  const { store, mail, env = {} } = deps;
  const seen = new Set();
  const list = items.filter((i) => i && i.user_id && !seen.has(`${i.user_id}|${i.kind}|${i.post_id}|${i.ref_id}`) && seen.add(`${i.user_id}|${i.kind}|${i.post_id}|${i.ref_id}`));
  if (!list.length) return [];
  const rows = await store.insert("notifications", list.map((i) => ({
    user_id: i.user_id, kind: i.kind, title: String(i.title).slice(0, 160), body: i.body ? String(i.body).slice(0, 600) : null,
    post_id: i.post_id || null, ref_id: i.ref_id || null
  })));
  if (mail) {
    try {
      const ids = [...new Set(list.map((i) => i.user_id))];
      const profiles = await store.rows("profiles", { id: { in: ids } });
      const byId = new Map(profiles.map((p) => [p.id, p]));
      const site = env.SITE_URL || "https://propertystalkers.com";
      await mail.send(list.flatMap((i) => {
        const p = byId.get(i.user_id);
        if (!p || !p.email || p.notify_email === false) return [];
        return [{ email: p.email, name: p.name, title: i.title, body: i.body, link: i.post_id ? `${site}/#p=${i.post_id}` : `${site}/#inbox` }];
      }));
    } catch (e) { console.error("Email step failed", e); }
  }
  return rows;
}
