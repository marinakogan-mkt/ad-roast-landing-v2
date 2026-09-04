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

const SCORE_MODEL = process.env.ANTHROPIC_ICP_MODEL || 'claude-haiku-4-5';

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

// One cheap Haiku call scores the whole set: 1-10 fit-to-ICP + one-line verdict + a fix.
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
  const sys = `You are a B2B ad auditor. Return ONLY a JSON array, one object per ad index (include EVERY index you are given, none skipped), shape: {"i":0,"score":5,"verdict":"one short line","fix":"one short fix line"}. Base the verdict/fix on the ad's actual copy (from the text line and, when present, the words on its creative image).

SCORING SCALE (calibrate consistently, the SAME ad must always land on the same score, do NOT cluster at 0-1 or 9-10):
1-3 = actively hurting the click (severe ICP mismatch, no clear value, confusing).
4-6 = generic / average, where MOST real ads land (understandable but forgettable, weak proof or CTA).
7-8 = solid (clear ICP fit, specific value, a real reason to click).
9-10 = best-in-class (sharp hook, strong proof, unmistakable CTA).
An image-only ad with a readable value proposition is NOT a 1: judge the copy shown on the creative. Only score 1-2 when the ad is genuinely broken or badly mismatched to the ICP.

No markdown. Never use em dashes or en dashes; use commas or periods.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      // temperature 0: the SAME ads must score the SAME way run to run. Default temp made the
      // board swing (e.g. Google avg 1.1 one run, 7.7 the next) — pure sampling noise, not signal.
      body: JSON.stringify({ model: SCORE_MODEL, max_tokens: 1600, temperature: 0, system: sys, messages: [{ role: 'user', content }] }),
    });
    const d = await r.json();
    const txt = d.content?.[0]?.text || '';
    const mm = txt.match(/\[[\s\S]*\]/);
    if (!mm) return ads;
    const scores = JSON.parse(mm[0]);
    const byI = {};
    for (const s of scores) if (typeof s.i === 'number') byI[s.i] = s;
    return ads.map((a, i) => byI[i] ? { ...a, score: byI[i].score, verdict: byI[i].verdict, fix: byI[i].fix } : a);
  } catch (e) { return ads; }
}

// --- LinkedIn (free, via Jina Reader) -------------------------------------------------
// Pull a company's real LinkedIn ads (creative image + copy). Returns UNSCORED cards.
async function fetchLinkedInAds({ company, limit = 12 } = {}) {
  const q = (company || '').trim();
  if (!q) return { ok: false, reason: 'no_company', ads: [] };
  const target = 'https://www.linkedin.com/ad-library/search?accountOwner=' + encodeURIComponent(q);
  const headers = { 'X-Return-Format': 'html', 'X-Timeout': '20' };
  // A free JINA_API_KEY (env) lifts the anonymous rate limit and makes this far more
  // reliable; without it we still work, just flakier under load.
  if (process.env.JINA_API_KEY) headers['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
  // Jina's anonymous proxy pool is flaky, so retry before giving up — a transient miss
  // otherwise drops LinkedIn from the board entirely. Budget-bounded (2 x ~24s) to stay
  // inside the 60s function limit alongside the Google fetch and the scoring call.
  let lastReason = 'error';
  // 3 attempts stays under the 60s function limit (Google runs in parallel; scoring runs
  // after). A JINA_API_KEY makes attempt 1 almost always succeed. The reason encodes whether
  // the key is even set (_keyed vs _anon) so a persistent 403 tells us if the env var is the
  // problem vs LinkedIn's Cloudflare blocking Jina's proxy pool.
  const keyed = !!process.env.JINA_API_KEY;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 700));
    const h = { ...headers };
    // Last attempt: Jina's browser engine renders the page in a real headless browser, which
    // gets past LinkedIn's Cloudflare 403 far more often than the default proxy pool. Slower,
    // so only as a final fallback (403s return fast, leaving budget for one longer try inside
    // the 60s function limit: ~15s default + ~26s browser + Google in parallel, scoring after).
    const lastTry = attempt === 1;
    if (lastTry) h['X-Engine'] = 'browser';
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), lastTry ? 26000 : 15000);
      const r = await fetch('https://r.jina.ai/' + target, { headers: h, signal: controller.signal });
      clearTimeout(t);
      if (!r.ok) { lastReason = 'jina_' + r.status + (keyed ? '_keyed' : '_anon'); continue; }
      const html = await r.text();
      // Only keep ads that carry a real creative image — every board card must show a real
      // creative, never a text-only placeholder tile.
      const ads = parseAdCards(html, q).filter(a => a.img).slice(0, limit);
      if (ads.length) return { ok: true, ads };
      lastReason = 'no_ads';
    } catch (e) { lastReason = String(e && e.message || e); }
  }
  return { ok: false, reason: lastReason, ads: [] };
}

// --- Google (free, via Ads Transparency Center RPC) -----------------------------------
// The Transparency Center site loads an advertiser's ads through an internal RPC that
// needs no auth. We call it directly with the domain and pull the real static creatives
// (tpc.googlesyndication.com/archive/simgad/...). Region 2764 = "anywhere". We keep only
// image creatives so every Google card shows a real creative (display/HTML ads carry no
// static image and no separate copy, so they'd be empty cards). Returns UNSCORED cards.
async function fetchGoogleAds({ domain, limit = 12 } = {}) {
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
    if (ads.length >= limit) break;
  }
  return { ok: true, ads };
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
    if (data && data.error) return { ok: false, reason: 'meta_error:' + (data.error.code || ''), ads: [] };
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
    fetchGoogleAds({ domain, limit: 12 }).catch(() => ({ ok: false, ads: [] })),
    fetchMetaAds({ company, domain, limit: 12 }).catch(() => ({ ok: false, ads: [], reason: 'meta_fetch_failed' })),
  ]);
  const sources = { linkedin: (li.ads || []).length, google: (gg.ads || []).length, meta: (mt.ads || []).length };
  // Surface why a source came back empty (e.g. LinkedIn Jina rate-limit, Meta no-token) even when
  // another source succeeded, so the UI can tell "none running" from "we couldn't fetch it".
  const notes = {
    linkedin: (li.ads && li.ads.length) ? 'ok' : (li.reason || 'no_ads'),
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
