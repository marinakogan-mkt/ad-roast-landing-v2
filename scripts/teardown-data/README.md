# Teardown generator

Rebuilds a redesigned `/teardowns/<slug>` page (two-window ad to landing,
expandable findings, animated 5-axis scorecard, FAQ + JSON-LD). Self-contained:
downloads the ad creative + a thum.io landing screenshot + the logo and
base64-inlines them, so the page ships with no external image deps.

## Add a teardown

1. Run a real AdRoast roast of the ad (gives the overall score, the 5 axis
   scores, the issues, and a `report_id` to cite).
2. Copy one of the JSON files here as `<slug>.json` and fill it in (hook, lede,
   findings, scorecard, faq, related, `roast_id`, image URLs). No em/en dashes:
   hyphen, comma, colon only. Double quotes in body text go in as `“ ”`.
   Logo source that resolves reliably: `https://icons.duckduckgo.com/ip3/<domain>.ico`
   (clearbit is often blocked). Landing shot: `https://image.thum.io/get/width/1200/crop/1150/wait/8/https://<domain>/`.
3. Generate:

   ```
   python3 scripts/gen_teardown.py teardowns/clickup/index.html \
     scripts/teardown-data/<slug>.json teardowns/<slug>/index.html
   ```

   (arg 1 is any existing page, used only to borrow the shared inline CSS.)
4. Add the page to: `teardowns/index.html` (card + JSON-LD ItemList),
   `sitemap.xml`, and the proof list in `api/_board-og.js`. Optionally the home
   "Full teardowns" grid in `index.html` (keep it balanced).
5. Verify locally (`python3 -m http.server`, open the page), then commit + push.

The redesigned set so far: monday, klaviyo, webflow, clickup, pipedrive.
The 8 cyber pages (cycode, silverfort, semgrep, descope, hyperproof, apiiro,
endor-labs, ox-security) still use the older embed-centric design.
