# AdRoast: LinkedIn Ad Library API setup

Goal: get official, free, automatic advertiser + ad detection from LinkedIn ad links,
so we stop depending on scraping (which LinkedIn now blocks via Cloudflare).

This replaces the "type the advertiser's website" fallback with 100% automatic detection,
once approved and the keys are in Vercel.

---

## What Marina does (account + terms actions, Claude can't do these)

### Step 1 — Company Page (probably already have one)
The developer app must be linked to a LinkedIn Company Page you admin.
- If AdRoast has a Page: good.
- If not: create one at https://www.linkedin.com/company/setup/new/ (free, 2 min).

### Step 2 — Create the developer app
1. Go to https://www.linkedin.com/developers/apps/ and sign in.
2. Click "Create app".
3. Fill: App name (AdRoast), the LinkedIn Page from step 1, app logo, and check the
   legal agreement.
4. Create.

### Step 3 — Verify the app
- LinkedIn asks you to verify the app through the Company Page (a verify link the Page
  admin approves). Click through it. Takes ~1 min.

### Step 4 — Request the "Ad Library API" product
1. In your app, open the "Products" tab.
2. Find "Ad Library API" and click "Request access".
3. If it shows a use-case form, describe the real use case honestly:
   "AdRoast audits a single B2B SaaS ad the user submits and gives a scored breakdown.
   We use the Ad Library API to fetch the advertiser and ad creative for the ad link the
   user pastes, so we can analyze it. No bulk collection, one ad per user request."
4. Submit and wait for approval (transparency product, usually lighter than the paid
   Marketing Developer Platform, but still days to a few weeks).

### Step 5 — When approved, grab the credentials
1. In the app, open the "Auth" tab.
2. Copy the **Client ID** and **Client Secret**.
3. Send them to Claude to wire up (or add them yourself in Vercel, see below). Do NOT
   paste secrets anywhere public.

### Step 6 — Add the keys to Vercel (you do this, Claude can't handle secrets)
In Vercel > the AdRoast project > Settings > Environment Variables, add:
- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`
(plus an access token var if the flow needs one, TBD once we see the API's auth).
Then redeploy.

---

## What Claude does (once keys are in Vercel)

- Add the Ad Library API call inside `api/icp.js`: when the pasted link is a LinkedIn
  ad-library URL, call the official API instead of scraping the page.
- Extract the advertiser + ad creative + copy from the API response, feed it into the
  existing ICP + roast flow.
- Keep the current "type the website / paste the ad" fallback for any link the API can't
  resolve (e.g. non-LinkedIn platforms, or ads not in the API).

## Open questions to confirm on approval
- Can we resolve a SPECIFIC ad by the numeric ID in the link
  (e.g. /ad-library/detail/1452890813), or only search by company name? If only by
  company, the flow becomes: detect/ask company, then pull their ads.
- Auth model: OAuth 2-legged (client credentials) vs a generated access token.
- Whether non-EU ad data (advertiser + creative) is fully returned, or richest for EU ads.

## Status
- [ ] Company Page ready
- [ ] App created
- [ ] App verified
- [ ] Ad Library API product requested
- [ ] Approved
- [ ] Client ID / Secret in Vercel
- [ ] Claude wires up api/icp.js
