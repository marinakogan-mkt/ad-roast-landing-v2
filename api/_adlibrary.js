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
async function scoreAds(ads, icp) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !icp || !ads.length) return ads;
  const IMG_CAP = 14; // bound the vision tokens per board load
  let imgUsed = 0;
  const lines = [];
  const content = [{ type: 'text', text: '' }]; // header filled in after the loop
  for (let i = 0; i < ads.length; i++) {
    const a = ads[i];
    lines.push(`#${i} [${a.plat}] headline="${(a.head || '').slice(0, 140)}" body="${(a.body || '').slice(0, 220)}"`);
    if (a.img && imgUsed < IMG_CAP && /^https:\/\//i.test(a.img)) {
      content.push({ type: 'text', text: `Creative image for ad #${i}:` });
      content.push({ type: 'image', source: { type: 'url', url: a.img } });
      imgUsed++;
    }
  }
  content[0].text = `ICP: ${icp}\n\nScore each ad 1-10 for how well it fits this ICP and earns the click (1 = severe mismatch, 10 = excellent). Several ads include their creative image below; READ the copy/text rendered on each creative and judge it as the ad's copy. Ads:\n${lines.join('\n')}`;
  const sys = `You are a B2B ad auditor. Return ONLY a JSON array, one object per ad index, shape: {"i":0,"score":5,"verdict":"one short line","fix":"one short fix line"}. Base the verdict/fix on the ad's actual copy (from the text line and, when present, the words on its creative image). No markdown. Never use em dashes or en dashes; use commas or periods.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: SCORE_MODEL, max_tokens: 1600, system: sys, messages: [{ role: 'user', content }] }),
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
  const headers = { 'X-Return-Format': 'html', 'X-Timeout': '40' };
  if (process.env.JINA_API_KEY) headers['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 45000);
    const r = await fetch('https://r.jina.ai/' + target, { headers, signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: 'jina_' + r.status, ads: [] };
    const html = await r.text();
    // Only keep ads that carry a real creative image — every board card must show a real
    // creative, never a text-only placeholder tile.
    return { ok: true, ads: parseAdCards(html, q).filter(a => a.img).slice(0, limit) };
  } catch (e) { return { ok: false, reason: 'error', detail: String(e && e.message || e), ads: [] }; }
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

// Merge a company's real ads across sources (LinkedIn + Google), score the whole set in one
// pass, and return one list. LinkedIn is keyed by advertiser name, Google by domain, so we
// take both. Each source is best-effort: one failing never sinks the other.
export async function fetchAllAds({ company, domain, icp, limit = 24 } = {}) {
  const [li, gg] = await Promise.all([
    fetchLinkedInAds({ company, limit: 12 }).catch(() => ({ ok: false, ads: [] })),
    fetchGoogleAds({ domain, limit: 12 }).catch(() => ({ ok: false, ads: [] })),
  ]);
  const sources = { linkedin: (li.ads || []).length, google: (gg.ads || []).length };
  let ads = [...(li.ads || []), ...(gg.ads || [])].slice(0, limit);
  if (!ads.length) return { ok: false, reason: (li.reason || gg.reason || 'no_ads'), ads: [], sources };
  if (icp) ads = await scoreAds(ads, icp);
  return { ok: true, ads, count: ads.length, sources };
}

// Back-compat: LinkedIn-only fetch + score (kept for any caller still using it).
export async function fetchAdsViaJina({ company, icp, limit = 12 } = {}) {
  const li = await fetchLinkedInAds({ company, limit });
  if (!li.ok) return li;
  let ads = li.ads;
  if (icp && ads.length) ads = await scoreAds(ads, icp);
  return { ok: true, ads, count: ads.length };
}
