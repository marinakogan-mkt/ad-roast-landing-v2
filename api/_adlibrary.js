// Helper (underscore prefix => NOT a Vercel Serverless Function, so it does not count
// against the Hobby 12-function cap). Pulls a company's REAL live LinkedIn ads (with the
// actual creative images) for the "Your Live Ads" dashboard.
//
// Why Jina: LinkedIn's official Ad Library API returns no creative image, and its ad-library
// pages block server reads (Cloudflare 403). Jina Reader (r.jina.ai) renders the public
// ad-library search page through its own proxy pool, gets past the block, and is FREE (no
// key needed; an optional JINA_API_KEY raises rate limits). The rendered HTML carries each
// ad's creative as media.licdn.com URLs (data-delayed-url), which are hotlinkable, plus the
// ad copy and the advertiser. We parse those cards and score them.
//
// Env: JINA_API_KEY (optional, higher limits). ANTHROPIC_API_KEY reused for the gravity score.
//
// Called from api/icp.js (action: 'ads-fetch') so we add no new function. Synchronous:
// one fetch + parse + score, no polling.

// Sonnet 4.6 (not Haiku): it reads non-English creative copy and judges buyer-fit far more
// accurately, and unlike Sonnet 5 it still accepts temperature (kept at 0 for determinism).
// Token cost is bounded HARD by scoreAdsCached: only creatives NOT already in the 30-day cache
// are sent to the model, so a re-scored board pays Sonnet vision only for new/changed ads.
// NOTE: if ANTHROPIC_ICP_MODEL is set in the env it overrides this; unset it to use Sonnet 4.6.
const SCORE_MODEL = process.env.ANTHROPIC_ICP_MODEL || 'claude-sonnet-4-6';

function decodeHtml(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…').replace(/&#x27;/g, "'");
}
function stripTags(s) { return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); }
function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Parse the rendered ad-library search HTML into ad cards. Each preview card contains the
// advertiser name (a font-bold div), the body copy (commentary__content), and a content
// image anchor (/ad-library/detail/{id}) whose <img data-delayed-url> is the real creative
// and whose alt is the headline. We anchor on that image link and read back for the rest.
function parseAdCards(html, company) {
  const out = [];
  const seen = new Set();
  const anchorRe = /<a href="\/ad-library\/detail\/(\d+)[^"]*ad_library_ad_preview_content_image[\s\S]{0,1400}?<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const block = m[0];
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const imgM = block.match(/data-delayed-url="(https:\/\/media\.licdn\.com[^"]+)"/);
    const altM = block.match(/<img[^>]*\balt="([^"]*)"/);
    const img = imgM ? decodeHtml(imgM[1]) : null;
    const headline = altM ? decodeHtml(altM[1]).trim() : '';
    const pre = html.slice(Math.max(0, m.index - 2600), m.index);
    const adv = [...pre.matchAll(/font-bold[^>]*>\s*([^<]{1,90}?)\s*<\/div>/g)];
    const advertiser = adv.length ? decodeHtml(adv[adv.length - 1][1]).trim() : '';
    const bod = [...pre.matchAll(/commentary__content[^>]*>([\s\S]*?)<\/p>/g)];
    const body = bod.length ? decodeHtml(stripTags(bod[bod.length - 1][1])).trim() : '';
    out.push({ id, advertiser, headline, body, img });
  }
  // Collapse repeats: the same creative often runs across several campaigns and shows up
  // as multiple cards. Keep one per unique creative (by image, falling back to headline).
  const uniq = [];
  const key = new Set();
  for (const a of out) {
    const k = (a.img ? a.img.split('?')[0] : '') || (a.headline || '') || a.id;
    if (key.has(k)) continue;
    key.add(k);
    uniq.push(a);
  }
  // We query by accountOwner (advertiser), so every returned card already belongs to the
  // company; no name filtering needed (and thought-leader ads show a person in the byline).
  return uniq.map(a => ({
    plat: 'LinkedIn',
    head: a.headline || (a.body || '').slice(0, 80) || '(untitled ad)',
    body: a.body || '',
    img: a.img,                 // real creative image (media.licdn.com), or null for text ads
    cta: null,
    ctaUrl: null,
    dom: null,
    advertiser: a.advertiser || null,
    detailUrl: 'https://www.linkedin.com/ad-library/detail/' + a.id,
    adId: a.id,
  }));
}

// One Sonnet 4.6 vision call scores the whole set: 1-10 fit-to-ICP + one-line verdict + a fix.
// Multimodal: each ad contributes a text line AND (capped) its creative image, because the
// copy that sells the ad usually lives ON the creative, and Google image ads carry no
// separate text at all. Images are passed as URL sources (Anthropic fetches them), so we
// don't download them here. Best-effort; any failure returns the ads unscored.
// Fetch a creative and return it as a base64 image block. Anthropic's own URL-image fetch
// silently fails for many ad CDNs (tpc.googlesyndication.com in particular), which made the
// model score image-only ads "no copy, cannot evaluate" = a bogus 1. Fetching server-side
// (same path the /api/icp?img= proxy uses) and sending base64 GUARANTEES the model sees the
// creative, so image-only Google ads get judged on the copy printed on them.
async function _fetchImgB64(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    let r;
    try {
      r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
    } finally { clearTimeout(t); }
    if (!r.ok) return null;
    let ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(ct)) return null;
    if (ct === 'image/jpg') ct = 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 4_000_000) return null;
    return { media_type: ct, data: buf.toString('base64') };
  } catch (e) { return null; }
}

async function scoreAds(ads, icp) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !icp || !ads.length) return ads;
  const IMG_CAP = 14; // bound the vision tokens per board load
  // Pre-fetch the creatives (parallel, server-side) as base64 so the model actually sees them.
  const toFetch = [];
  for (let i = 0; i < ads.length && toFetch.length < IMG_CAP; i++) {
    if (ads[i].img && /^https:\/\//i.test(ads[i].img)) toFetch.push(i);
  }
  const b64s = await Promise.all(toFetch.map(i => _fetchImgB64(ads[i].img)));
  const imgByIdx = {};
  toFetch.forEach((i, k) => { if (b64s[k]) imgByIdx[i] = b64s[k]; });

  const lines = [];
  const content = [{ type: 'text', text: '' }]; // header filled in after the loop
  for (let i = 0; i < ads.length; i++) {
    const a = ads[i];
    lines.push(`#${i} [${a.plat}] headline="${(a.head || '').slice(0, 140)}" body="${(a.body || '').slice(0, 220)}"`);
    if (imgByIdx[i]) {
      content.push({ type: 'text', text: `Creative image for ad #${i}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: imgByIdx[i].media_type, data: imgByIdx[i].data } });
    } else if (a.img && /^https:\/\//i.test(a.img)) {
      // Fallback: couldn't fetch it ourselves, let Anthropic try the URL.
      content.push({ type: 'text', text: `Creative image for ad #${i}:` });
      content.push({ type: 'image', source: { type: 'url', url: a.img } });
    }
  }
  content[0].text = `ICP: ${icp}\n\nScore each ad 1-10 for how well it fits this ICP and earns the click (1 = severe mismatch, 10 = excellent). Several ads include their creative image below; READ the copy/text rendered on each creative and judge it as the ad's copy. Ads:\n${lines.join('\n')}`;
  const sys = `You are a B2B ad auditor. Return ONLY a JSON array, one object per ad index (include EVERY index you are given, none skipped), shape: {"i":0,"score":5,"title":"3 to 6 word name for the ad","verdict":"one short line","fix":"one short fix line"}. The title names the ad in a list: for an image ad with no headline text, READ the main line printed on the creative and use that (or a short plain descriptor of the offer), under 6 words, no trailing period. Base the title/verdict/fix on the ad's actual copy (from the text line and, when present, the words on its creative image).

SCORING SCALE (calibrate consistently, the SAME ad must always land on the same score, do NOT cluster at 0-1 or 9-10):
1-3 = actively hurting the click (severe ICP mismatch, no clear value, confusing).
4-6 = generic / average, where MOST real ads land (understandable but forgettable, weak proof or CTA).
7-8 = solid (clear ICP fit, specific value, a real reason to click).
9-10 = best-in-class (sharp hook, strong proof, unmistakable CTA).
An image-only ad with a readable value proposition is NOT a 1: judge the copy shown on the creative. Only score 1-2 when the ad is genuinely broken or badly mismatched to the ICP.

BLANK / EMPTY CREATIVE: if a creative is a blank or collapsed ad slot with NO visible content (a solid or empty image, no text, no logo, no offer), do NOT invent content or a verdict for it. Set title EXACTLY to "Blank ad", score 1, verdict "Empty ad slot, nothing to show." These are filtered out of the board, so a clean canonical title matters.

BRAND / NON-DEMAND-GEN: some ads are NOT trying to sell the product to a buyer: employer branding, company culture, life-at-company, hiring or recruiting, team or award celebrations, event recaps, CSR. These are brand or talent plays, not demand-gen, and that is by design. Do NOT score them 1-2 as "wrong buyer" or "no ICP signal" just because they do not pitch the buyer. Judge them as brand content: a coherent brand or culture post lands around 5. The verdict must NAME it a brand or culture post (not a demand-gen ad) so it is never flagged as the "fix this first". Only a genuine demand-gen ad (offering the product, a demo, trial, or download) that misses the buyer earns a 1-3.

LOCALIZATION: ads may be localized on purpose, written in another language and aimed at a specific country. That is deliberate, not a defect. Do NOT lower the score for the language or the geo. Read and translate the ad, then judge how well it speaks to the SAME buyer ROLE in its own market. Never make the verdict or fix about the ad being in another language or region-specific, and never say "no ICP signal" or "unclear buyer" when the signal is simply expressed in that language. Judge substance only: hook, clarity, proof, CTA, value for its intended local buyer.

No markdown. Never use em dashes or en dashes; use commas or periods.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      // temperature 0: the SAME ads must score the SAME way run to run. Default temp made the
      // board swing (e.g. Google avg 1.1 one run, 7.7 the next) — pure sampling noise, not signal.
      // Sonnet 4.6 accepts temperature (Sonnet 5 rejects it), so determinism is preserved.
      // max_tokens 2000: headroom for up to 14 terse JSON rows. A truncated output fails the JSON
      // parse and wastes the WHOLE call (incl. the expensive vision input), so the cap sits just
      // above real need rather than at it. Billing is by actual output, so the cap is not a cost.
      body: JSON.stringify({ model: SCORE_MODEL, max_tokens: 2000, temperature: 0, system: sys, messages: [{ role: 'user', content }] }),
    });
    const d = await r.json();
    const txt = d.content?.[0]?.text || '';
    const mm = txt.match(/\[[\s\S]*\]/);
    if (!mm) return ads;
    const scores = JSON.parse(mm[0]);
    const byI = {};
    for (const s of scores) if (typeof s.i === 'number') byI[s.i] = s;
    // head falls back to the model's title so image-only Google ads (no headline text) still
    // show a real name in the board/preview instead of "Live creative".
    return ads.map((a, i) => byI[i] ? { ...a, score: byI[i].score, verdict: byI[i].verdict, fix: byI[i].fix, title: byI[i].title || null, head: a.head || byI[i].title || '' } : a);
  } catch (e) { return ads; }
}

// --- Per-creative score cache (token optimization) ------------------------------------
// Pulling the ad LIST is FREE (Jina / Google RPC / Meta API, no LLM). The ONLY token cost is
// scoreAds (a Haiku vision call). So instead of caching one scored blob per domain for hours
// (which goes stale the moment the advertiser adds/removes a creative), we cache the SCORE per
// individual creative, keyed by a stable creative signature + a hash of the ICP. On every board
// load we re-pull the current list (cheap) and only send the creatives we've NEVER scored before
// to the model. Unchanged creatives reuse their cached score (0 tokens); a newly launched creative
// costs one score; a paused/removed creative simply isn't in the fresh pull. Result: the board is
// effectively real-time on which ads are live, while tokens are spent only on genuinely new ads.
const ADSCORE_TTL = 60 * 60 * 24 * 30; // 30 days: a creative's fit-to-ICP score doesn't drift.

// Stable id for a creative so the SAME ad maps to the SAME cache slot across pulls. Platform ad
// ids are stable; fall back to the image URL sans query (LinkedIn/Google signed params change).
function creativeSig(a) {
  if (a.adId) return (a.plat || '') + ':id:' + a.adId;
  if (a.img) return (a.plat || '') + ':img:' + String(a.img).split('?')[0];
  return (a.plat || '') + ':h:' + (a.head || a.body || '').slice(0, 80);
}
// Short deterministic hash of the ICP text: a different ICP => a different cache namespace, so a
// re-scored account with a changed buyer definition doesn't reuse stale scores.
function icpHash(icp) {
  const s = String(icp || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Score a pulled ad list, reusing per-creative cached scores and only calling the model on the
// creatives we haven't scored yet. `force` (the Retry button) bypasses the reuse and re-scores all.
// Returns { ads, scoredNew, reused }. If redis is unavailable it just scores everything (old path).
export async function scoreAdsCached(ads, icp, redis, { force = false, limit = 0 } = {}) {
  if (!icp || !ads.length) return { ads, scoredNew: 0, reused: 0, pending: 0 };
  if (!redis) { const scored = await scoreAds(ads, icp); return { ads: scored, scoredNew: ads.length, reused: 0, pending: 0 }; }
  const ih = icpHash(icp);
  // Namespace bumped to v2 on 2026-09-12 to invalidate scores made before the localization / blank /
  // brand-vs-demand-gen scoring rules, so existing boards re-score under the fixed prompt. Batched
  // scoring keeps that re-score under the 60s limit; it is a one-time cost per board on next load.
  const keyOf = (a) => 'adscore:v2:' + ih + ':' + creativeSig(a);
  const cachedBySig = {};
  if (!force) {
    try {
      const vals = await redis.mget(...ads.map(keyOf));
      ads.forEach((a, i) => {
        const v = vals && vals[i];
        const o = v ? (typeof v === 'string' ? JSON.parse(v) : v) : null;
        if (o && typeof o.score === 'number') cachedBySig[creativeSig(a)] = o;
      });
    } catch (e) { /* miss -> score all */ }
  }
  const need = ads.filter(a => !cachedBySig[creativeSig(a)]);
  // Bound how many NEW creatives we score in one call: scoreAds is a Sonnet vision call, and the
  // pull + scoring must fit Vercel's 60s function limit. On a big FRESH board that one call 504s, so
  // we score at most `limit` per request and report `pending`; the client re-calls to score the rest
  // (the list is cached by then, so those calls skip the pull). limit 0 = no cap (score everything).
  const toScore = (limit > 0 && need.length > limit) ? need.slice(0, limit) : need;
  const freshBySig = {};
  if (toScore.length) {
    const scored = await scoreAds(toScore, icp);
    const writes = [];
    for (const a of scored) {
      if (typeof a.score !== 'number') continue;
      const o = { score: a.score, verdict: a.verdict, fix: a.fix, title: a.title || null };
      freshBySig[creativeSig(a)] = o;
      writes.push(redis.set(keyOf(a), JSON.stringify(o), { ex: ADSCORE_TTL }));
    }
    try { await Promise.all(writes); } catch (e) { /* best-effort */ }
  }
  const out = ads.map(a => {
    const o = cachedBySig[creativeSig(a)] || freshBySig[creativeSig(a)];
    return o ? { ...a, score: o.score, verdict: o.verdict, fix: o.fix, title: o.title || a.title || null, head: a.head || o.title || '' } : a;
  });
  return { ads: out, scoredNew: toScore.length, reused: Object.keys(cachedBySig).length, pending: need.length - toScore.length };
}

// --- LinkedIn (free, via Jina Reader) -------------------------------------------------
// Pull a company's real LinkedIn ads (creative image + copy). Returns UNSCORED cards.
// PRIMARY LinkedIn source: the Apify public LinkedIn Ad Library actor. Unlike Jina's anonymous pool
// (shared IP rate-limit + fingerprinting) this is reliable, needs no login, and is cheap-per-ad
// ($0.0015/ad, capped by maxResults). Needs APIFY_TOKEN. Returns our normalized ad shape, or a
// reason so fetchLinkedInAds can fall back to Jina.
async function fetchLinkedInAdsViaApify({ company, limit = 12 } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { ok: false, reason: 'no_apify_token', ads: [] };
  const q = (company || '').trim();
  if (!q) return { ok: false, reason: 'no_company', ads: [] };
  // countries must be real ISO codes (not "ALL") and dateOption is required — matching the actor's
  // validated example. A spread of major B2B markets so we don't miss a company's ads by region.
  // Force RESIDENTIAL proxies — datacenter proxies (the default/free) get blocked by LinkedIn's
  // Cloudflare, which is exactly why the actor's runs were failing. Residential IPs get through, and
  // a LinkedIn scrape is small (~MBs) so it stays within Apify's free monthly credits.
  const input = { searchTerms: [q], searchMode: 'accountOwner', countries: ['US'], dateOption: 'last-year', maxResults: 20, fetchAdDetails: false, proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000); // cap wasted time when LinkedIn blocks the actor's proxies; falls back to Jina after
    const r = await fetch('https://api.apify.com/v2/acts/khadinakbar~linkedin-ads-scraper/run-sync-get-dataset-items?token=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: c.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: 'apify_' + r.status, ads: [] };
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) return { ok: false, reason: 'apify_no_ads', ads: [] };
    // Field names vary across actor versions, so read each defensively.
    const pick = (o, keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; };
    const ads = items.map(it => {
      const cr = it.creative || it;
      const img = pick(it, ['imageUrl', 'image', 'imageURL', 'creativeImageUrl', 'creativeImage', 'thumbnailUrl']) || pick(cr, ['imageUrl', 'image', 'imageURL']);
      const head = pick(it, ['headline', 'title', 'head']) || pick(cr, ['headline', 'title']) || '';
      const body = pick(it, ['copy', 'body', 'text', 'description', 'commentary']) || pick(cr, ['copy', 'body', 'text']) || '';
      const adId = pick(it, ['adId', 'id', 'adLibraryId']) || (it.url ? (String(it.url).match(/(\d{6,})/) || [])[1] : null);
      const detailUrl = pick(it, ['url', 'adUrl', 'detailUrl', 'sourceUrl']) || (adId ? 'https://www.linkedin.com/ad-library/detail/' + adId : null);
      const advertiser = pick(it, ['advertiserName', 'advertiser', 'payerName', 'accountName']) || null;
      return { plat: 'LinkedIn', head: (head || (body || '').slice(0, 80) || '(untitled ad)'), body: body || '', img, cta: null, ctaUrl: null, dom: null, advertiser, detailUrl, adId };
    }).filter(a => a.img && /^https?:\/\//i.test(String(a.img)));
    // Same ad often repeats across countries — keep one per creative/id.
    const seen = new Set();
    const uniq = [];
    for (const a of ads) { const k = a.adId || String(a.img).split('?')[0]; if (seen.has(k)) continue; seen.add(k); uniq.push(a); }
    const out = uniq.slice(0, limit);
    if (!out.length) return { ok: false, reason: 'apify_no_creatives', ads: [] };
    return { ok: true, ads: out, via: 'apify' };
  } catch (e) { return { ok: false, reason: 'apify_error:' + String(e && e.message || e).slice(0, 40), ads: [] }; }
}

export async function fetchLinkedInAds({ company, limit = 12 } = {}) {
  const q = (company || '').trim();
  if (!q) return { ok: false, reason: 'no_company', ads: [] };
  // Try Apify first (reliable, no rate-limit fingerprint); fall back to Jina's anon pool if it's not
  // configured or comes back empty.
  // Apify is wired up (fetchLinkedInAdsViaApify), but the khadinakbar actor is currently broken —
  // even with residential proxies it fails at page 0 ("LinkedIn search requests failed"), so calling
  // it only adds ~18s of latency for nothing. Gate it behind APIFY_LINKEDIN=1 so it's trivial to
  // re-enable once a WORKING actor is found (just set the env var), without slowing pulls today.
  let apifyReason = process.env.APIFY_TOKEN ? (process.env.APIFY_LINKEDIN === '1' ? 'apify_not_run' : 'apify_disabled') : 'apify_no_token';
  if (process.env.APIFY_TOKEN && process.env.APIFY_LINKEDIN === '1') {
    const ap = await fetchLinkedInAdsViaApify({ company: q, limit });
    if (ap.ok && ap.ads && ap.ads.length) return { ...ap, _apify: 'ok' };
    apifyReason = ap.reason || 'apify_empty';
  }
  const target = 'https://www.linkedin.com/ad-library/search?accountOwner=' + encodeURIComponent(q);
  // A JINA_API_KEY lifts the anonymous rate limit. BUT a depleted/invalid key returns 401/402/403
  // and would make LinkedIn fail HARDER than no key at all — so if a keyed attempt hits one of
  // those, we DROP the key and fall back to Jina's anonymous pool for the remaining attempts.
  // Never let a bad key be worse than no key.
  let useKey = !!process.env.JINA_API_KEY;
  let lastReason = 'error';
  // 2 attempts stay under the 60s function limit (Google runs in parallel; scoring runs after).
  // Attempt 0: default engine (fast; an auth/credit failure returns in ~1s so the key-drop is cheap).
  // Attempt 1: Jina's browser engine, which gets past LinkedIn's Cloudflare far more often.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 600));
    // Jina bills per OUTPUT token, so strip the heavy non-content before it counts: scripts, styles,
    // svg, iframes. These are the bulk of a LinkedIn page's weight and CANNOT contain an ad card
    // (whose detail-anchor + data-delayed-url creative is real DOM), so parseAdCards is unaffected
    // while the returned payload — and the token cost per read — drops sharply. (Deliberately does
    // NOT strip nav/header/footer/aside: tiny extra savings, small risk of eating a card, not worth it.)
    const h = { 'X-Return-Format': 'html', 'X-Timeout': '20', 'X-Remove-Selector': 'script,style,noscript,svg,iframe' };
    if (useKey) h['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
    const lastTry = attempt === 1;
    if (lastTry) h['X-Engine'] = 'browser';
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), lastTry ? 26000 : 15000);
      const r = await fetch('https://r.jina.ai/' + target, { headers: h, signal: controller.signal });
      clearTimeout(t);
      if (!r.ok) {
        lastReason = 'jina_' + r.status + (useKey ? '_keyed' : '_anon');
        // Key out of credits (402) or unauthorized (401/403): drop it, retry anonymously next round.
        if (useKey && (r.status === 402 || r.status === 401 || r.status === 403)) useKey = false;
        continue;
      }
      const html = await r.text();
      // Only keep ads that carry a real creative image — every board card must show a real
      // creative, never a text-only placeholder tile.
      const ads = parseAdCards(html, q).filter(a => a.img).slice(0, limit);
      if (ads.length) return { ok: true, ads, _apify: apifyReason };
      lastReason = 'no_ads';
    } catch (e) { lastReason = String(e && e.message || e); }
  }
  return { ok: false, reason: lastReason, ads: [], _apify: apifyReason };
}

// --- Google (free, via Ads Transparency Center RPC) -----------------------------------
// The Transparency Center site loads an advertiser's ads through an internal RPC that
// needs no auth. We call it directly with the domain and pull the real static creatives
// (tpc.googlesyndication.com/archive/simgad/...). Region 2764 = "anywhere". We keep only
// image creatives so every Google card shows a real creative (display/HTML ads carry no
// static image and no separate copy, so they'd be empty cards). Returns UNSCORED cards.
async function fetchGoogleAds({ domain, company, limit = 12 } = {}) {
  const dom = (domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();
  if (!dom) return { ok: false, reason: 'no_domain', ads: [] };
  const url = 'https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=';
  const reqBody = 'f.req=' + encodeURIComponent(JSON.stringify({ '2': 40, '3': { '12': { '1': dom, '2': true } }, '7': { '1': 1, '2': 0, '3': 2764 } }));
  let data;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-same-domain': '1',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': '*/*',
      },
      body: reqBody,
      signal: c.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: 'google_' + r.status, ads: [] };
    data = JSON.parse(await r.text());
  } catch (e) { return { ok: false, reason: 'google_error', detail: String(e && e.message || e), ads: [] }; }

  const arr = Array.isArray(data && data['1']) ? data['1'] : [];
  const ads = [];
  const seen = new Set();
  for (const c of arr) {
    const cr = c && c['3'];
    const htmlImg = cr && cr['3'] && cr['3']['2'];   // image creatives: an <img src="...simgad..."> string
    let img = null;
    if (typeof htmlImg === 'string') {
      const m = htmlImg.match(/https:\/\/tpc\.googlesyndication\.com\/archive\/simgad\/\d+/);
      if (m) img = m[0];
    }
    if (!img || seen.has(img)) continue;
    seen.add(img);
    const AR = c['1'], CR = c['2'];
    ads.push({
      plat: 'Google', head: '', body: '', img,
      cta: null, ctaUrl: null, dom,
      advertiser: c['12'] || null,
      detailUrl: (AR && CR) ? `https://adstransparency.google.com/advertiser/${AR}/creative/${CR}?region=anywhere` : 'https://adstransparency.google.com/?region=anywhere&domain=' + encodeURIComponent(dom),
      adId: CR || null,
    });
  }
  // Google's domain search returns creatives from EVERY advertiser whose ads point at this domain.
  // For a normal company that's just them (semgrep.dev -> one advertiser). But a shared site-host
  // domain (notion.so, carrd.co, framer.website, ...) returns unrelated small businesses that use
  // it to host their landing page (a stone-crusher factory, a Korean dev shop). Keep only the
  // company's OWN ads:
  //  - advertisers whose name matches the company/domain token (notion -> "Notion Labs Japan"), else
  //  - if a SINGLE advertiser owns the whole result the domain maps cleanly to one account, which can
  //    be a person/agency name that does not contain the brand (semgrep.dev -> "Pablo Estrada"), so
  //    keep all; else (several advertisers, none match) it is a shared host with no owned ads -> none.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const domTok = norm(dom.replace(/\.[a-z.]+$/i, '')); // notion.so -> "notion"
  const coTok = norm(company);
  const nameMatches = (adv) => {
    const a = norm(adv);
    if (!a) return false;
    if (domTok && domTok.length >= 4 && (a.includes(domTok) || domTok.includes(a))) return true;
    if (coTok && coTok.length >= 4 && (a.includes(coTok) || coTok.includes(a))) return true;
    return false;
  };
  const owned = ads.filter(a => nameMatches(a.advertiser));
  let kept;
  if (owned.length) kept = owned;
  else { const distinct = new Set(ads.map(a => norm(a.advertiser))).size; kept = distinct <= 1 ? ads : []; }
  return { ok: true, ads: kept.slice(0, limit) };
}

// ---- Meta (Facebook + Instagram) via the OFFICIAL Ad Library API ----------------------------
// Requires META_ADLIBRARY_TOKEN (a Meta access token from an identity-confirmed Meta app).
// Without it we return nothing and the UI keeps Meta as "coming soon". The API only exposes
// non-political ("commercial") ads that were delivered in the EU/UK (a DSA effect) plus
// political/issue ads globally — so for a US-only advertiser this is often empty, which is
// EXPECTED, not a bug. We query the full EU-27 + UK with ad_type=ALL (the maximum coverage the
// API allows) and resolve each creative image from its snapshot page.
const META_EU_UK = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB'];

async function _fetchMetaSnapshot(url) {
  // ad_snapshot_url embeds the access token and is fetchable server-side (unlike the bot-walled
  // public library page). Its HTML carries the creative URLs in embedded JSON — pull the first
  // usable image + destination link + CTA text.
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    let r;
    try { r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' } }); } finally { clearTimeout(t); }
    if (!r.ok) return {};
    const html = await r.text();
    const unesc = (s) => s ? s.replace(/\\\//g, '/').replace(/\\u003D/gi, '=').replace(/\\u0026/gi, '&') : s;
    const pick = (re) => { const m = html.match(re); return m ? unesc(m[1]) : null; };
    const img = pick(/"original_image_url":"(https:[^"]+)"/) || pick(/"resized_image_url":"(https:[^"]+)"/) || pick(/"video_preview_image_url":"(https:[^"]+)"/);
    const link = pick(/"link_url":"(https?:[^"]+)"/);
    const cta = pick(/"cta_text":"([^"]+)"/);
    return { img, link, cta };
  } catch (e) { return {}; }
}

export async function fetchMetaAds({ company, domain, limit = 12 } = {}) {
  const token = process.env.META_ADLIBRARY_TOKEN;
  if (!token) return { ok: false, reason: 'no_token', ads: [] };
  const term = (company || domain || '').trim();
  if (!term) return { ok: false, reason: 'no_query', ads: [] };
  const params = new URLSearchParams({
    access_token: token,
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    ad_reached_countries: JSON.stringify(META_EU_UK),
    search_terms: term,
    fields: 'id,page_id,page_name,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,ad_snapshot_url,publisher_platforms,ad_delivery_start_time',
    limit: '25',
  });
  const url = 'https://graph.facebook.com/v21.0/ads_archive?' + params.toString();
  let data;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    let r;
    try { r = await fetch(url, { signal: c.signal }); } finally { clearTimeout(t); }
    data = await r.json();
    if (data && data.error) {
      const e = data.error;
      // Surface the full Meta error (code + subcode + message) so we can diagnose exactly why a
      // valid token still fails (e.g. permission, identity confirmation, verification).
      const detail = 'meta_error:' + (e.code || '') + (e.error_subcode ? '/' + e.error_subcode : '') + ':' + String(e.message || '').slice(0, 180);
      return { ok: false, reason: detail, ads: [] };
    }
  } catch (e) { return { ok: false, reason: 'meta_fetch_failed', ads: [] }; }
  let items = Array.isArray(data.data) ? data.data : [];
  // search_terms is fuzzy — keep only ads whose Page name plausibly matches the advertiser.
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(company || domain);
  if (want) items = items.filter(a => { const pn = norm(a.page_name); return pn && (pn.indexOf(want) !== -1 || want.indexOf(pn) !== -1); });
  items = items.slice(0, limit);
  const enriched = await Promise.all(items.map(async (a) => {
    const snap = a.ad_snapshot_url ? await _fetchMetaSnapshot(a.ad_snapshot_url) : {};
    const body = (a.ad_creative_bodies && a.ad_creative_bodies[0]) || '';
    const head = (a.ad_creative_link_titles && a.ad_creative_link_titles[0]) || (a.ad_creative_link_captions && a.ad_creative_link_captions[0]) || (body ? body.slice(0, 80) : '(untitled ad)');
    return {
      plat: 'Meta',
      head,
      body,
      img: snap.img || null,
      cta: snap.cta || null,
      ctaUrl: snap.link || null,
      dom: null,
      advertiser: a.page_name || null,
      region: 'EU/UK',
      detailUrl: a.ad_snapshot_url || ('https://www.facebook.com/ads/library/?q=' + encodeURIComponent(term)),
      adId: a.id,
    };
  }));
  return { ok: true, ads: enriched, reason: enriched.length ? 'ok' : 'no_ads' };
}

// Merge a company's real ads across sources (LinkedIn + Google + Meta EU/UK), score the whole
// set in one pass, and return one list. Each source is best-effort: one failing never sinks the
// others. Meta only returns data when META_ADLIBRARY_TOKEN is set and the advertiser ran ads in
// the EU/UK; otherwise the UI keeps Meta as "coming soon".
export async function fetchAllAds({ company, domain, icp, limit = 36 } = {}) {
  const [li, gg, mt] = await Promise.all([
    fetchLinkedInAds({ company, limit: 12 }).catch(() => ({ ok: false, ads: [] })),
    fetchGoogleAds({ domain, company, limit: 12 }).catch(() => ({ ok: false, ads: [] })),
    fetchMetaAds({ company, domain, limit: 12 }).catch(() => ({ ok: false, ads: [], reason: 'meta_fetch_failed' })),
  ]);
  const sources = { linkedin: (li.ads || []).length, google: (gg.ads || []).length, meta: (mt.ads || []).length };
  // Surface why a source came back empty (e.g. LinkedIn Jina rate-limit, Meta no-token) even when
  // another source succeeded, so the UI can tell "none running" from "we couldn't fetch it".
  const notes = {
    linkedin: (li.ads && li.ads.length) ? 'ok' : (li.reason || 'no_ads'),
    linkedin_apify: li._apify || null, // debug: why Apify was/wasn't used for LinkedIn
    google: (gg.ads && gg.ads.length) ? 'ok' : (gg.reason || 'no_ads'),
    meta: (mt.ads && mt.ads.length) ? 'ok' : (mt.reason || 'no_ads'),
  };
  let ads = [...(li.ads || []), ...(gg.ads || []), ...(mt.ads || [])].slice(0, limit);
  if (!ads.length) return { ok: false, reason: (li.reason || gg.reason || mt.reason || 'no_ads'), ads: [], sources, notes };
  if (icp) ads = await scoreAds(ads, icp);
  return { ok: true, ads, count: ads.length, sources, notes };
}

// Back-compat: LinkedIn-only fetch + score (kept for any caller still using it).
export async function fetchAdsViaJina({ company, icp, limit = 12 } = {}) {
  const li = await fetchLinkedInAds({ company, limit });
  if (!li.ok) return li;
  let ads = li.ads;
  if (icp && ads.length) ads = await scoreAds(ads, icp);
  return { ok: true, ads, count: ads.length };
}
