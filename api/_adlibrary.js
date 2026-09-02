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
  // Keep only this advertiser's ads when we can match the name; the keyword search also
  // returns competitors' ads that merely mention the company.
  const cn = norm(company);
  const mine = out.filter(a => cn && norm(a.advertiser).includes(cn));
  const chosen = mine.length ? mine : out;
  return chosen.map(a => ({
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
// Best-effort; any failure returns the ads unscored.
async function scoreAds(ads, icp) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !icp || !ads.length) return ads;
  const list = ads.map((a, i) => `#${i}: headline="${(a.head || '').slice(0, 140)}" body="${(a.body || '').slice(0, 220)}"`).join('\n');
  const sys = `You are a B2B ad auditor. Score each ad 1-10 for how well it fits the target ICP and earns the click (1 = severe mismatch, 10 = excellent). Return ONLY a JSON array, one object per ad index, shape: {"i":0,"score":5,"verdict":"one short line","fix":"one short fix line"}. No markdown. Never use em dashes or en dashes; use commas or periods.`;
  const usr = `ICP: ${icp}\n\nAds:\n${list}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: SCORE_MODEL, max_tokens: 1600, system: sys, messages: [{ role: 'user', content: usr }] }),
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

// Fetch + parse + (optionally) score a company's real LinkedIn ads. Free via Jina Reader.
export async function fetchAdsViaJina({ company, icp, limit = 12 } = {}) {
  const q = (company || '').trim();
  if (!q) return { ok: false, reason: 'no_company', ads: [] };
  const target = 'https://www.linkedin.com/ad-library/search?keyword=' + encodeURIComponent(q);
  const headers = { 'X-Return-Format': 'html', 'X-Timeout': '40' };
  if (process.env.JINA_API_KEY) headers['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
  let html;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 45000);
    const r = await fetch('https://r.jina.ai/' + target, { headers, signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: 'jina_' + r.status, ads: [] };
    html = await r.text();
  } catch (e) { return { ok: false, reason: 'error', detail: String(e && e.message || e), ads: [] }; }

  let ads = parseAdCards(html, q).slice(0, limit);
  if (icp && ads.length) ads = await scoreAds(ads, icp);
  return { ok: true, ads, count: ads.length };
}
