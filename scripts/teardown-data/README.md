# Teardown generator

Builds a redesigned `/teardowns/<slug>` page (two-window ad to landing,
expandable findings, animated 5-axis scorecard, FAQ + JSON-LD) and wires it into
the site. Self-contained: downloads the ad creative + a thum.io landing
screenshot + the logo and base64-inlines them, so the page ships with no
external image deps.

## The input (v2)

One JSON with three parts: `meta`, `voice`, `roast`. See `pipedrive.json`.

- `roast`: paste the output of a real `roast_ad` call (overall_score, issues
  with title/score/explanation, landing_page_score). The 5-axis scorecard and
  the ring score are built straight from this, no retyping, so the numbers on
  the page are the product's own.
- `voice`: the only part that needs judgment and Marina's tone, hook (two lines),
  lede, findings (punchy title + what + fix, Ad/Page tag), faq. If `voice` omits
  `findings`, they are auto-derived from the roast issues. If it omits
  `scorecard`, it comes from the roast issues in order.
- `meta`: slug, name, domain, platform, date, human_date, initial, badge_color,
  ad_img (creative URL from list_live_ads), roast_link (or roast_id), title,
  meta_desc, og_desc, keywords, card_desc, related. `logo_url` and `lp_url`
  default to DuckDuckGo favicon + the homepage via thum.io if omitted.

## Generate + wire it in, one command

```
python3 scripts/gen_teardown.py teardowns/clickup/index.html \
  scripts/teardown-data/<slug>.json teardowns/<slug>/index.html --integrate
```

- arg 1 is any existing page, used only to borrow the shared inline CSS.
- `--integrate` adds the page to `teardowns/index.html` (card, newest first, +
  JSON-LD ItemList renumbered), `sitemap.xml`, and the `/work-with-us` proof list
  in `api/_board-og.js`. Idempotent: re-running skips files that already have the
  slug. Drop `--integrate` to only write the page.

Then verify locally (`python3 -m http.server`, open the page) and commit + push.
The home "Full teardowns" grid in `index.html` is left alone on purpose (keep it
a balanced four); add there by hand if wanted.

## Gotchas

- No em/en dashes anywhere (project rule): hyphen, comma, colon. Double quotes in
  body text go in as `“ ”`; straight apostrophes are curled for you.
- `logo.clearbit.com` is often blocked from the shell; the DuckDuckGo favicon
  (`icons.duckduckgo.com/ip3/<domain>.ico`, ~32x32 PNG) resolves reliably.
- thum.io sometimes returns a spinner on a cold fetch; the generator retries, and
  `/wait/8/` gives the page time to render.

## State

Redesigned set: monday, klaviyo, webflow, clickup, pipedrive.
The 8 cyber pages (cycode, silverfort, semgrep, descope, hyperproof, apiiro,
endor-labs, ox-security) still use the older embed-centric design. Migrating one
needs a fresh roast (for the screenshots + 5-axis), then this generator; the old
copy can be lifted from the existing page.
