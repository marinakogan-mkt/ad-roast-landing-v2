// Vercel serverless function — infer a company's ICP from its website.
// Matches ad-roast-landing-v2 conventions: raw fetch to Anthropic (no SDK),
// x-api-key from env, regex-extracted JSON. Zero new dependencies.
//
//   POST /api/icp   { "url": "acme.com" }
//   → { brand, domain, url, summary, icp_text, tags: [] }
//
// Wire-up: call this when the user enters their site, then use `icp_text` to
// prefill the `icpDescription` field the roast already expects.

// Optimization #4: ICP detection is a simple extraction task, so run it on Haiku
// (~1/3 the input cost, ~1/3 the output cost of Sonnet) instead of the roast model.
// Output is editable by the user in the review step, so the quality tradeoff is safe.
// Its own env var (not the shared ANTHROPIC_MODEL) so it doesn't inherit Sonnet.
const MODEL = process.env.ANTHROPIC_ICP_MODEL || 'claude-haiku-4-5';

/* ICP cache (token optimization): the ICP inferred from a given page is stable, so we
   cache it and reuse it instead of re-running Haiku every roast. IMPORTANT: the page the
   user submits is almost always an AD-LIBRARY link (Meta / LinkedIn / Google), whose HOST
   is the shared ad platform — NOT the advertiser. Keying the cache by host therefore made
   every advertiser on the same platform collide (paste a Drop Zone ad, get back the Ionix
   ICP that was cached first under `facebook.com`). So we key by the FULL normalized URL
   (hashed): each distinct ad link gets its own entry, and re-detecting the exact same link
   still hits cache. Pass { refresh: true } to force a fresh inference. Redis is optional:
   if it's unavailable we just skip the cache and infer. */
import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import { fetchAdsViaJina, fetchAllAds } from './_adlibrary.js';

// The Ad Library fetch renders a page via Jina and runs a quick Haiku score, so allow headroom.
export const config = { maxDuration: 60 };
let _redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
} catch (e) { _redis = null; }
const ICP_CACHE_TTL = 60 * 60 * 24 * 60; // 60 days

function normalizeUrl(input) {
  let raw = (input || '').trim();
  if (!raw) throw new Error('No URL provided.');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const url = new URL(raw);
  const domain = url.hostname.replace(/^www\./, '');
  const brand = domain.split('.')[0];
  return { url: url.toString(), domain, brand: brand.charAt(0).toUpperCase() + brand.slice(1) };
}

async function fetchSite(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: {
        // Send the full set of headers a real Chrome sends, in a plausible order.
        // This won't beat a datacenter-IP block (LinkedIn/Meta Cloudflare), but it
        // clears the lighter bot checks some marketing sites run on their own pages.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
    const desc = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] || '').trim();
    const body = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10000);
    /* Bot-check / anti-bot interstitials (Cloudflare "Just a moment", Akamai, captcha,
       access-denied) are NOT the advertiser's content. If we return that text, the model
       reads "Cloudflare" and names the CDN as the company (the Semgrep -> Cloudflare bug).
       Treat a blocked page as no content so we don't feed the blocker's name to the model. */
    const probe = (title + ' ' + body).toLowerCase();
    // Challenge-page markers only (not bare vendor names), so a legit page that merely
    // mentions Cloudflare isn't wrongly treated as blocked.
    const blocked = /just a moment|checking (if the site connection is secure|your browser)|attention required! \| cloudflare|cloudflare ray id|cf-ray|enable javascript and cookies (to continue)?|verify you are (human|a human)|please (enable cookies|complete the security check)|complete the captcha|are you a robot|request (unsuccessful|blocked)|ddos protection by|generated by cloudflare|access to this page has been denied/i.test(probe);
    if (blocked || body.length < 40) return { title: '', desc: '', body: '', blocked: true };
    return { title, desc, body, blocked: false };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  /* Image proxy (GET /api/icp?img=<encoded url>). Ad creatives live on
     tpc.googlesyndication.com (Google) and media.licdn.com (LinkedIn) — hosts that every
     ad-blocker (uBlock, Brave, AdBlock) blocks by name, so hotlinked creatives silently
     vanish for anyone running one. Re-serving them from our own origin defeats that: the
     browser only ever sees adroast.in/api/icp?img=..., which no blocklist matches.
     Host-allowlisted + image-content-type-checked so it can't be used as an open proxy.
     Folded into this function (not a new one) to stay under the Hobby 12-function cap. */
  if (req.method === 'GET' && req.query && req.query.img) {
    try {
      const raw = Array.isArray(req.query.img) ? req.query.img[0] : req.query.img;
      const u = new URL(raw);
      const ALLOW = /(^|\.)licdn\.com$|(^|\.)googlesyndication\.com$|(^|\.)gstatic\.com$|(^|\.)ggpht\.com$/i;
      if (u.protocol !== 'https:' || !ALLOW.test(u.hostname)) {
        return res.status(400).json({ error: 'Host not allowed' });
      }
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 9000);
      let upstream;
      try {
        upstream = await fetch(u.toString(), {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
        });
      } finally { clearTimeout(t); }
      if (!upstream.ok) return res.status(502).json({ error: 'Upstream ' + upstream.status });
      const ct = upstream.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//i.test(ct)) return res.status(415).json({ error: 'Not an image' });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(502).json({ error: 'Proxy failed' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  // Ad Library dashboard (real ad creatives, free) is served from this same function to stay
  // under the Hobby 12-function cap. It carries no url, so handle it before normalizeUrl
  // (which requires one). Pulls LinkedIn (Jina) + Google (Ads Transparency RPC) in parallel,
  // scores them together, returns one merged list.
  if (body.action === 'ads-fetch') {
    /* Cache the board result so we don't hammer Jina on every load. LinkedIn's free path
       (Jina anonymous) has a low rate limit: the first call returns the ads, rapid repeats
       start returning 403 and LinkedIn vanishes. Caching means once LinkedIn comes through
       it's reused (stays visible) instead of being re-fetched (and re-failing) every visit.
       TTL is long when LinkedIn actually loaded, short otherwise so we keep retrying it soon
       AND give Jina's per-minute limit time to recover between attempts. refresh:true (the
       'change'/Retry buttons) bypasses the cache to force a fresh pull. */
    const ck = 'ads:' + String(body.domain || body.company || '').trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (_redis && ck !== 'ads:' && !body.refresh) {
      try {
        const raw = await _redis.get(ck);
        const cached = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        if (cached && cached.ads && cached.ads.length) return res.status(200).json({ ...cached, _cached: true });
      } catch (e) { /* miss -> fetch */ }
    }
    const result = await fetchAllAds({ company: body.company, domain: body.domain, icp: body.icp });
    if (_redis && ck !== 'ads:' && result && result.ok && result.ads && result.ads.length) {
      const liOk = result.notes && result.notes.linkedin === 'ok';
      const ttl = liOk ? 60 * 60 * 6 : 60 * 3; // 6h once LinkedIn is in; 3min retry window while it isn't
      try { await _redis.set(ck, JSON.stringify(result), { ex: ttl }); } catch (e) {}
    }
    return res.status(200).json(result);
  }

  let brand, domain, url;
  try {
    ({ brand, domain, url } = normalizeUrl(body.url));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Reuse a previously inferred ICP for this exact page (skip the Haiku call entirely)
  // unless the caller explicitly asked to refresh it. Keyed by the FULL url, not the
  // host, so different ad-library links on the same platform never collide.
  const urlHash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  const icpCacheKey = `icp:url:${urlHash}`;
  if (_redis && !body.refresh) {
    try {
      const raw = await _redis.get(icpCacheKey);
      const cached = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (cached && cached.icp_text) return res.status(200).json({ ...cached, _cached: true });
    } catch (e) { /* cache miss / outage -> infer below */ }
  }

  // Fetch the site (best-effort — if it fails we infer from the domain alone).
  let site = { title: brand, desc: '', body: '' };
  try { site = await fetchSite(url); } catch (e) { /* keep fallback */ }

  const systemPrompt = `You are a B2B go-to-market analyst. From a page, identify the advertiser company and infer its Ideal Customer Profile — the specific buyer its ads should target. Be concrete about role, company stage, and spend. Do not invent facts that contradict the content.

The page may be the company's own website, OR an ad-library / ad-transparency page (Meta, Google, or LinkedIn) that shows one of the company's ads. If it is an ad-library page, identify the advertiser from the content and infer their real company website.

NEVER name a CDN, hosting, security, or anti-bot provider (Cloudflare, Akamai, Fastly, Imperva, Vercel, AWS, etc.) as the advertiser just because the page mentions it or is served by it, that is infrastructure, not the company being advertised. If the page content is missing, thin, or a bot-check / "just a moment" / access-denied interstitial so you cannot actually tell who the advertiser is, do NOT guess a specific company: return "company" and "website" as empty strings, keep "summary"/"icp_text"/"tags" generic (a plausible B2B buyer the user can correct), and never fabricate a well-known brand.

Return ONLY valid JSON. No markdown, no backticks, no text before or after. Exact shape:
{
  "company": "the advertiser company name",
  "website": "the company's own website as a full https:// URL (best guess)",
  "summary": "2-3 sentences on who this company sells to and the pain those buyers feel",
  "icp_text": "one tight sentence naming the target buyer, company profile, and ad spend",
  "tags": ["4-6 short chips like 'B2B Cybersecurity', 'Series A-C', 'CISOs', '$20K+/mo ad spend'"]
}
Never use em dashes or en dashes in any field value. Use commas, colons, or periods instead.`;

  const userPrompt = `Company domain: ${domain}
Page title: ${site.title}
Meta description: ${site.desc}

Homepage text:
${site.body || '(the page content could not be read: it was empty, JS-rendered, or a bot-check page. Do NOT guess a specific advertiser or a well-known brand. Return empty company and website, and a generic B2B ICP the user can correct.)'}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message || 'API error' });
    }

    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Could not parse ICP response' });
    }
    const icp = JSON.parse(jsonMatch[0]);

    /* Deterministic safety net (belt to the prompt's suspenders): if the model named a
       CDN / host / security / anti-bot vendor as the advertiser, and the page we fetched
       ISN'T that vendor's own site, it latched onto infrastructure (the Semgrep -> Cloudflare
       bug). Blank the company/website so the user fills them in, and never fabricate a brand. */
    const INFRA_VENDORS = ['cloudflare', 'akamai', 'fastly', 'imperva', 'incapsula', 'perimeterx', 'datadome', 'sucuri', 'distil', 'vercel', 'netlify', 'heroku', 'cloudfront', 'amazon web services', 'google cloud', 'microsoft azure'];
    const compLc = (icp.company || '').toLowerCase();
    const siteLc = (icp.website || '').toLowerCase();
    const inputIsVendor = INFRA_VENDORS.some(v => domain.includes(v.replace(/\s+/g, '')));
    const namedVendor = INFRA_VENDORS.some(v => compLc.includes(v) || siteLc.includes(v.replace(/\s+/g, '')));
    const poisoned = namedVendor && !inputIsVendor;
    if (poisoned) { icp.company = ''; icp.website = ''; }

    const result = { brand, domain, url, ...icp };

    /* Cache a confident, clean inference. Also cache on an explicit refresh so the
       "Re-detect" button OVERWRITES a previously poisoned entry (e.g. the cached
       Cloudflare result) with the cleaned one, clearing it for good. Never cache the
       raw poisoned inference itself. */
    if (_redis && !poisoned && (body.refresh || icp.company)) {
      try { await _redis.set(icpCacheKey, JSON.stringify(result), { ex: ICP_CACHE_TTL }); } catch (e) {}
    }
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
