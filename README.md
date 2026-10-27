# Property Stalkers — setup guide

A map of properties and requests across India. People post in plain words, for example
"I am the landlord and want to sell my 3 bedroom in Skyview, Sector 7, Gurugram for 1.5 Cr".
An AI assistant checks the details, asks for anything missing, shows a summary to confirm,
and then the post appears on the Google map.

## How it works

Anyone can open the site and start browsing straight away, without signing in:
- **Search bar** at the top: type an area, building, project, developer or city. Matching listed properties show instantly. Press Enter, or choose "Show … on the map", to move the map to that place.
- **Filters**: All, For sale, For rent and New projects. **List** shows every property in the current map view.

| Who posts | Shows on the map as | Who can see it |
|---|---|---|
| Landlord (owner) selling or renting out | Emerald price pin | Everyone, including visitors who aren't signed in |
| Broker with licence / RERA number | Emerald price pin, labelled "Broker · Licence …" | Everyone |
| Broker **without** licence number | Posted as **Landlord** | Everyone |
| Developer (company name required) | Brass "New · price+" pin, under **New projects** | Everyone |
| Buyer looking to purchase | Pin under **Requests** | Only brokers who gave a licence / RERA number |
| Tenant looking to rent | Pin under **Requests** | Only brokers who gave a licence / RERA number |

- Listings work anywhere in the world. Prices are kept in their own currency (₹, AED, $, £ and so on).
- Location is required for every post: the building or area, plus the city. If Google can't find it, the assistant asks again.
- Everyone always sees their own posts. Admins see everything and can remove any post.
- These rules run on the server, so a request's details never reach anyone who isn't allowed to see them.
- Each person's name and mobile number (asked once, with country code) are shown on their posts with Call and WhatsApp buttons.
- Limits: 40 AI messages and 10 posts per person per day (change them in `netlify/lib/core.mjs`, `LIMITS`).

## What's in this folder

| Path | What it is |
|---|---|
| `public/index.html` | The website (map, cards, sign-in, posting chat) |
| `netlify/functions/api.mjs` | The server, run by Netlify |
| `netlify/lib/` | Server logic: rules (`core.mjs`), AI (`ai.mjs`), Google geocoding (`geo.mjs`), database (`db.mjs`) |
| `supabase/schema.sql` | Database tables, locked down, plus photo storage |
| `test/` | Automated tests (`npm test`) |

## Setup (about an hour, no coding)

You'll create four free accounts, copy some keys, and paste them into Netlify.

### 1. Supabase (database, sign-in, photos)

1. Go to supabase.com and create a project. Choose the **Mumbai** region. Save the database password somewhere safe.
2. Open **SQL Editor > New query**, paste the whole of `supabase/schema.sql`, and click **Run**.
3. Open **Authentication > URL Configuration**:
   - **Site URL**: `https://propertystalkers.com`
   - **Redirect URLs**: add `https://propertystalkers.com/**`, `https://www.propertystalkers.com/**` and `https://*.netlify.app/**`
4. **Before launch**, open **Authentication > Emails > SMTP Settings** and connect an email sender such as Brevo, Resend or Zoho. Supabase's built-in email is only for testing and sends just a few emails an hour.
5. Open **Project Settings > API** and copy three values:
   - Project URL → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (**secret**: never share it or put it in the website)

### 2. Google Maps

1. Go to console.cloud.google.com, create a project, and add a billing account (Google requires one even for the free usage).
2. Under **APIs & Services > Library**, enable **Maps JavaScript API** and **Geocoding API**.
3. Under **APIs & Services > Credentials**, create **two** API keys:
   - **Browser key** → `GOOGLE_MAPS_BROWSER_KEY`. Restrict it by **Websites** to `https://propertystalkers.com/*`, `https://www.propertystalkers.com/*` and `https://*.netlify.app/*`, and by **API** to Maps JavaScript API only.
   - **Server key** → `GOOGLE_GEOCODING_KEY`. Restrict it by **API** to Geocoding API only. Leave the application restriction as None, because Netlify's servers don't have fixed addresses.
4. Optional: under **Google Maps Platform > Map management**, create a Map ID (type JavaScript) → `GOOGLE_MAP_ID`. Without it the site uses Google's demo map style, which works fine.
5. Set a **budget alert** under **Billing > Budgets & alerts**, for example ₹2,000 a month, so you're warned before any surprise.

### 3. Claude (the posting assistant)

1. Go to console.anthropic.com, create an account, and add a small amount of credit.
2. Create an API key → `ANTHROPIC_API_KEY` (**secret**).

### 4. GitHub (stores the code)

1. Create a free account at github.com and a new **private** repository called `propertystalkers`.
2. Click **uploading an existing file** and drag in everything from this folder, **except** `node_modules` if it's there. Click **Commit changes**.

### 5. Hosting

The live site now runs on **Cloudflare Pages** (free plan, no per-update credits). The server code is in `functions/api/[[path]].js`, which reuses `netlify/lib/`. Netlify instructions below are kept for reference.

### 5a. Netlify (old host)

1. At netlify.com, choose **Add new site > Import an existing project > GitHub** and pick `propertystalkers`. Netlify reads the settings from `netlify.toml`, so leave the build settings as they are.
2. Before deploying, open **Environment variables** and add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | from step 1 |
| `SUPABASE_ANON_KEY` | from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 (secret) |
| `GOOGLE_MAPS_BROWSER_KEY` | from step 2 |
| `GOOGLE_GEOCODING_KEY` | from step 2 |
| `GOOGLE_MAP_ID` | from step 2 (optional) |
| `ANTHROPIC_API_KEY` | from step 3 (secret) |
| `ADMIN_EMAILS` | your email, e.g. `you@gmail.com` (comma-separate several) |

3. Click **Deploy**. When it's done, open the `…netlify.app` link and post something to test it.
4. Under **Domain management**, add `propertystalkers.com` and follow the DNS instructions Netlify shows. HTTPS is set up automatically.

If you change an environment variable later, go to **Deploys > Trigger deploy** so the site picks it up.

## Running costs

- **Netlify, Supabase**: free plans are enough to start.
- **Google Maps**: each product has a monthly free allowance (around 10,000 map loads and 10,000 address lookups at the time of writing), then you pay per 1,000. One lookup happens per post, and one per area search (repeated searches are cached).
- **Claude Haiku 5.5**: well under ₹1 per post at current prices.
- **Email sender** for sign-in links: free tiers cover a few hundred emails a day.

Check each provider's pricing page for current rates.

## Good to know

- **RERA numbers are not verified automatically.** State RERA portals don't offer a way to check them, so the site only checks the format. As admin, you can remove posts with fake numbers.
- **Sector-level pins**: if Google can't find the exact building, the pin goes on the sector and the card says so.
- **Sign-in is by email link.** Phone OTP sign-in can be added later through Supabase with an SMS provider such as MSG91, for a small fee per SMS.
- To use the smarter (pricier) AI model, add `AI_MODEL` = `claude-sonnet-5-5` in Netlify.

## For developers

```
npm install
npm test
```

The tests cover the visibility rules, validation, rate limits, photo checks, and the AI and Google request formats.
