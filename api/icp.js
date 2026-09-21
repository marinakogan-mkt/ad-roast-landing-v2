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
// The ICP is the backbone of the whole board: every ad is scored AGAINST it, so a thin or
// too-narrow ICP silently degrades every score (a real vertical ad reads as "off-target"). It is
// cached per URL for 60 days, so a stronger model here is a ONE-TIME cost per company that lifts
// the accuracy of the entire board. Sonnet 4.6 (accepts temperature 0) over Haiku for that reason.
const MODEL = process.env.ANTHROPIC_ICP_MODEL || 'claude-sonnet-4-6';

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
import { fetchAdsViaJina, fetchAllAds, fetchGoogleAds, fetchLinkedInAds, scoreAdsCached, dropJunkCreatives, ownedByAdvertiser } from './_adlibrary.js';
import { logoCandidates, normDomain } from './_logo.js';
import { readSessionCookie, PORTAL_ROLES } from './auth/_allowlist.js';

// Admin emails (the portal master role) — the only accounts allowed to force a re-score of a board.
const ADMIN_EMAILS = new Set(((PORTAL_ROLES.find(r => r.mode === 'master') || {}).emails || []).map(e => String(e).toLowerCase()));
async function icpIsAdmin(req, redis) {
  try {
    const tok = readSessionCookie(req);
    if (!tok || !redis) return false;
    const s = await redis.get('auth:session:' + tok);
    const sess = s ? (typeof s === 'string' ? JSON.parse(s) : s) : null;
    return !!(sess && sess.email && ADMIN_EMAILS.has(String(sess.email).toLowerCase()));
  } catch (e) { return false; }
}

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

/* Jina Reader fallback: when the direct fetch is blocked/rate-limited (429, Cloudflare, JS-only
   pages), render the page through r.jina.ai (same proxy that gets us past LinkedIn's block) and
   return its clean readable text. This is why sublime.security etc. now resolve a real ICP instead
   of "page content insufficient". */
async function fetchSiteViaJina(url) {
  const attempt = async (useKey) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 13000);
    try {
      const headers = { 'X-Return-Format': 'text', 'X-Timeout': '15' };
      if (useKey && process.env.JINA_API_KEY) headers['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
      const r = await fetch('https://r.jina.ai/' + url, { headers, signal: c.signal });
      if (!r.ok) return { ok: false, status: r.status };
      const text = (await r.text()).replace(/\s+/g, ' ').trim().slice(0, 10000);
      if (text.length < 40) return { ok: false, status: 0 };
      return { ok: true, body: text };
    } catch (e) { return { ok: false, status: -1 }; } finally { clearTimeout(t); }
  };
  const hasKey = !!process.env.JINA_API_KEY;
  let res = await attempt(hasKey);
  // A depleted/invalid key (402/401/403) must never be worse than no key: retry anonymously.
  if (!res.ok && hasKey && (res.status === 402 || res.status === 401 || res.status === 403)) res = await attempt(false);
  return res.ok ? { title: '', desc: '', body: res.body, blocked: false } : null;
}

/* Fetch a page as raw HTML through the Jina proxy (X-Return-Format: html), so we can read its
   links. LinkedIn/Google ad-library detail pages are datacenter-IP blocked and JS-rendered, so a
   direct fetch returns nothing; Jina renders them. Used by the ad-landing resolver to pull the
   real click destination (the first outbound href) off an ad's own detail page. */
async function fetchHtmlViaJina(url) {
  const attempt = async (useKey) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    try {
      const headers = { 'X-Return-Format': 'html', 'X-Timeout': '20' };
      if (useKey && process.env.JINA_API_KEY) headers['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
      const r = await fetch('https://r.jina.ai/' + url, { headers, signal: c.signal });
      if (!r.ok) return { ok: false, status: r.status };
      const html = await r.text();
      if (!html || html.length < 200) return { ok: false, status: 0 };
      return { ok: true, html };
    } catch (e) { return { ok: false, status: -1 }; } finally { clearTimeout(t); }
  };
  const hasKey = !!process.env.JINA_API_KEY;
  let res = await attempt(hasKey);
  if (!res.ok && hasKey && (res.status === 402 || res.status === 401 || res.status === 403)) res = await attempt(false);
  return res.ok ? res.html : null;
}

async function fetchSite(url) {
  let direct = null;
  try { direct = await fetchSiteDirect(url); } catch (e) { direct = null; }
  if (direct && !direct.blocked && direct.body && direct.body.length >= 60) return direct;
  // Direct fetch blocked or thin -> try the Jina Reader proxy before giving up.
  const jina = await fetchSiteViaJina(url);
  if (jina && jina.body && jina.body.length >= 60) return jina;
  return direct || { title: '', desc: '', body: '', blocked: true };
}

async function fetchSiteDirect(url) {
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
  /* MCP server (/api/mcp, rewritten to /api/icp?mcp=1). Folded in here to stay under the Hobby
     12-function cap; the actual JSON-RPC handler lives in _mcp.js (an underscore helper). */
  if (req.query && req.query.mcp === '1') {
    const { mcpHandler } = await import('./_mcp.js');
    return mcpHandler(req, res);
  }
  /* Per-company link preview (/b/<slug> and /board/<slug>, rewritten to /api/icp?og=1&slug=<slug>).
     Serves the SPA shell with Open Graph tags rewritten for the company so a shared board link shows
     a card about THAT company, not the generic AdRoast card. Folded in here (helper _board-og.js) to
     stay under the Hobby 12-function cap, same pattern as the MCP handler above. */
  if (req.query && req.query.og !== undefined) {
    const { boardOgHandler } = await import('./_board-og.js');
    return boardOgHandler(req, res);
  }
  /* Per-company link-preview IMAGE (og:image), rewritten to /api/icp?ogimg=1&slug=<slug>. Renders a
     1200x630 PNG named for the company with its live board stats. Dynamic import so satori + resvg-wasm
     never load on the normal ICP/scoring path, and folded in here to stay under the Hobby 12-fn cap. */
  if (req.query && req.query.ogimg !== undefined) {
    const { boardOgImageHandler } = await import('./_board-og-image.mjs');
    return boardOgImageHandler(req, res);
  }
  /* Image proxy (GET /api/icp?img=<encoded url>). Ad creatives live on
     tpc.googlesyndication.com (Google) and media.licdn.com (LinkedIn) — hosts that every
     ad-blocker (uBlock, Brave, AdBlock) blocks by name, so hotlinked creatives silently
     vanish for anyone running one. Re-serving them from our own origin defeats that: the
     browser only ever sees adroast.in/api/icp?img=..., which no blocklist matches.
     Host-allowlisted + image-content-type-checked so it can't be used as an open proxy.
     Folded into this function (not a new one) to stay under the Hobby 12-function cap. */
  if (req.method === 'GET' && req.query && (req.query.img || req.query.p)) {
    try {
      let raw;
      if (req.query.p) {
        // base64url-encoded target so the blocked hostnames ("googlesyndication", "licdn")
        // never appear literally in the proxy URL — substring ad-blocker filters match the
        // whole URL incl. query, so ?img=https://...googlesyndication... was itself blocked.
        const b = Array.isArray(req.query.p) ? req.query.p[0] : req.query.p;
        raw = Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } else {
        raw = Array.isArray(req.query.img) ? req.query.img[0] : req.query.img;
      }
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

  /* Company-logo resolver + proxy (GET /api/icp?logo=<domain>). The real logo of a company is the
     one it declares on its OWN site (apple-touch-icon / schema.org logo / favicon); the browser can't
     read another domain's HTML because of CORS, so the board calls this instead. We resolve the
     ordered candidate list (declared-on-site first, Logo.dev + Google favicon as safety net), fetch
     the first that yields a real image, and re-serve the bytes from our own origin so hotlink
     protection and ad-blockers can't drop it. The winning URL is cached per domain (30d), so it's one
     fetch after the first hit. Folded into this function to stay under the Hobby 12-function cap. */
  if (req.method === 'GET' && req.query && req.query.logo !== undefined) {
    const domain = normDomain(Array.isArray(req.query.logo) ? req.query.logo[0] : req.query.logo);
    if (!domain) return res.status(400).json({ error: 'No domain' });
    const winKey = 'logo:winner:v1:' + domain;
    const tryFetch = async (u) => {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 8000);
      try {
        const up = await fetch(u, { signal: c.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } });
        if (!up.ok) return null;
        const ct = up.headers.get('content-type') || '';
        if (!/^image\//i.test(ct)) return null;
        const buf = Buffer.from(await up.arrayBuffer());
        if (buf.length < 100) return null; // 1x1 tracker / empty placeholder
        return { buf, ct };
      } catch (e) { return null; } finally { clearTimeout(t); }
    };
    const serve = (img) => {
      res.setHeader('Content-Type', img.ct);
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400');
      return res.status(200).send(img.buf);
    };
    try {
      // Fast path: a previously resolved winner for this domain.
      if (_redis) {
        try {
          const cached = await _redis.get(winKey);
          if (cached) { const img = await tryFetch(cached); if (img) return serve(img); }
        } catch (e) {}
      }
      const candidates = await logoCandidates(domain);
      for (const u of candidates) {
        const img = await tryFetch(u);
        if (img) {
          if (_redis) { try { await _redis.set(winKey, u, { ex: 60 * 60 * 24 * 30 }); } catch (e) {} }
          return serve(img);
        }
      }
      // Nothing resolved: redirect to the Google favicon so an <img> still shows something.
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.redirect(302, 'https://www.google.com/s2/favicons?sz=128&domain=' + domain);
    } catch (e) {
      return res.redirect(302, 'https://www.google.com/s2/favicons?sz=128&domain=' + domain);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  // First-party VISIT beacon: who entered and by which door (homepage vs a shared board/roast link),
  // where they came from (referrer + UTM), which link, approx geo, and their email if signed in.
  // Public and best-effort: it must never block or error the page. Stored capped in Redis; the admin
  // reads it at /api/roast-view?action=visits.
  if (body.action === 'visit') {
    try {
      if (_redis) {
        const h = req.headers || {};
        const clean = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
        let email = '';
        try {
          const tok = readSessionCookie(req);
          if (tok) { const s = await _redis.get('auth:session:' + tok); const sess = s ? (typeof s === 'string' ? JSON.parse(s) : s) : null; email = (sess && sess.email) || ''; }
        } catch (e) {}
        // Never log the admin's own visits: they'd swamp the real signal. Skipped either when the
        // session is an admin email, or when this browser carries the ar_notrack cookie (set the first
        // time the admin opens /visits, so even logged-out browsing from that browser is excluded).
        const _selfAdmin = !!email && ADMIN_EMAILS.has(String(email).toLowerCase());
        const _noTrack = /(?:^|;\s*)ar_notrack=1(?:;|$)/.test(String((req.headers || {}).cookie || ''));
        if (_selfAdmin || _noTrack) { res.setHeader('Cache-Control', 'no-store'); return res.status(204).end(); }
        const u = (body.utm && typeof body.utm === 'object') ? body.utm : {};
        const rec = {
          ts: Date.now(),
          path: clean(body.path, 300),
          entry: clean(body.entry, 24),          // 'home' | 'board' | 'report' | 'other'
          slug: clean(body.slug, 160),           // company slug or report id the link points at
          ref: clean(body.ref, 400),             // document.referrer
          refHost: clean(body.refHost, 120),
          utm: { source: clean(u.source, 80), medium: clean(u.medium, 80), campaign: clean(u.campaign, 120), term: clean(u.term, 80), content: clean(u.content, 120) },
          vid: clean(body.vid, 40),              // first-party visitor id (localStorage)
          ret: !!body.ret,                       // returning visitor
          dev: clean(body.dev, 16),              // 'mobile' | 'desktop'
          ua: clean(h['user-agent'], 200),
          geo: { country: clean(h['x-vercel-ip-country'], 8), region: clean(h['x-vercel-ip-country-region'], 16), city: (() => { try { return decodeURIComponent(clean(h['x-vercel-ip-city'], 80)); } catch (e) { return clean(h['x-vercel-ip-city'], 80); } })() },
          email,
        };
        await _redis.lpush('visits:log', JSON.stringify(rec));
        await _redis.ltrim('visits:log', 0, 9999); // keep the last ~10k visits
      }
    } catch (e) {}
    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
  }

  /* Resolve the landing page an ad points to, server-side (POST { action:'ad-landing', plat,
     detailUrl, adId, body, dom }). The board can't read another domain's ad-library detail page in
     the browser (CORS), so it asks the server. Mechanism proven in the outreach-engine's
     check_landings: the click destination is the FIRST outbound href on the ad's own detail page
     (LinkedIn/Google), and when the page exposes none, a URL the advertiser printed in the ad copy.
     We NEVER assume the homepage: if nothing resolves, we return null and the board asks the user for
     it (Marina's rule). Result cached per ad (7d). Meta already carries its ctaUrl, so the board
     never calls this for Meta. */
  if (body.action === 'ad-landing') {
    const plat = String(body.plat || '').toLowerCase();
    const detailUrl = String(body.detailUrl || '').trim();
    const adId = String(body.adId || '').trim();
    const adBody = String(body.body || '');
    const cacheKey = adId ? 'adland:v1:' + plat + ':' + adId : null;
    // Hosts that are the ad PLATFORM's own site/CDN/chrome — never the landing page. We do NOT
    // exclude link shorteners (lnkd.in) or the advertiser's social pages: lnkd.in is the real click
    // destination the advertiser used and redirects to the landing (roast follows it). Mirrors the
    // outreach-engine's proven filter (linkedin.com/licdn.com), plus the Google Transparency chrome.
    const OWN = /(^|\.)(linkedin\.com|licdn\.com|google\.com|gstatic\.com|googlesyndication\.com|googleadservices\.com|doubleclick\.net|youtube\.com|adstransparency\.google\.com)$/i;
    const isLanding = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') && /\./.test(x.hostname) && !OWN.test(x.hostname); } catch (e) { return false; } };
    const trim = (u) => String(u).replace(/[.,)\]]+$/, '');
    const fromHtml = (html) => { for (const m of String(html).matchAll(/href="(https?:\/\/[^"]+)"/gi)) { if (isLanding(m[1])) return m[1]; } return null; };
    const fromText = (t) => { for (const u of (String(t).match(/https?:\/\/[^\s<>"')]+/gi) || [])) { const c = trim(u); if (isLanding(c)) return c; } return null; };
    try {
      if (_redis && cacheKey) {
        try { const c = await _redis.get(cacheKey); if (c != null) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ landingUrl: c === '__none__' ? null : c, source: 'cache' }); } } catch (e) {}
      }
      let landing = null, source = null, definitive = false;
      // 1. The ad's own detail page: its first outbound href is the real click destination. Guard
      //    against a challenge/error shell (Jina hitting a Cloudflare 5xx, a "Failed to load" render):
      //    those carry bogus hrefs (e.g. cloudflare.com/5xx-error-landing) and must NOT be extracted
      //    or cached. Only a page that actually rendered is a definitive answer.
      if (detailUrl) {
        const html = await fetchHtmlViaJina(detailUrl);
        const broken = !html || html.length < 1500 || /just a moment|attention required|cloudflare ray|cf-ray|5xx-error-landing|\/error-landing|failed to load|enable javascript and cookies/i.test(html);
        if (html && !broken) {
          definitive = true;
          landing = fromHtml(html);
          if (landing) source = 'detail';
          else { const t2 = fromText(html); if (t2) { landing = t2; source = 'detail-text'; } }
        }
      }
      // 2. Fallback: a URL the advertiser printed in the ad copy (lead-gen ads expose no href). This
      //    is always a definitive read (it comes from data we already hold, not a live fetch).
      if (!landing && adBody) { const b = fromText(adBody); if (b) { landing = b; source = 'body'; definitive = true; } }
      // Cache only a definitive result (found, or a real page that genuinely had none). A transient
      // fetch failure returns null WITHOUT caching, so the next click retries instead of asking for 7d.
      if (_redis && cacheKey && definitive) { try { await _redis.set(cacheKey, landing || '__none__', { ex: 60 * 60 * 24 * 7 }); } catch (e) {} }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ landingUrl: landing, source: landing ? source : null });
    } catch (e) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ landingUrl: null, source: null });
    }
  }

  // Ad Library dashboard (real ad creatives, free) is served from this same function to stay
  // under the Hobby 12-function cap. It carries no url, so handle it before normalizeUrl
  // (which requires one). Pulls LinkedIn (Jina) + Google (Ads Transparency RPC) in parallel,
  // scores them together, returns one merged list.
  if (body.action === 'ads-fetch') {
    /* Two-layer cache so the board is real-time on WHICH ads are live, while spending model
       tokens only on genuinely new creatives:

       Layer A — the raw creative LIST (`ads:pull:<domain>`). Pulling the list is FREE (Jina /
       Google RPC / Meta API, no LLM), so we cache it only briefly: long enough not to hammer
       Jina's rate limit, short enough that a creative the advertiser ADDS or REMOVES surfaces
       within ~90min. This is the "is the account still the same?" check the board needs — done
       without any tokens.

       Layer B — the per-creative SCORE (`adscore:<icpHash>:<creativeSig>`, handled in
       scoreAdsCached, 30d TTL). After re-pulling the list we only send creatives we've never
       scored to the model; unchanged ones reuse their cached score (0 tokens), removed ones are
       just gone. So refreshing the list is nearly free even though the list itself is current.

       refresh:true (the 'change'/Retry buttons) bypasses Layer A only: it re-pulls the LIST so
       added/paused ads surface, but scoring stays incremental (only new creatives are scored, old
       ones keep their cached score). A full re-score from scratch would blow Vercel's 60s limit with
       the Sonnet scorer, so it is never forced; a changed ICP re-scores on its own via the icpHash. */
    const domKey = String(body.domain || body.company || '').trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
    const pullKey = 'ads:pull:' + domKey;
    const wantScore = !!body.icp; // the board always sends the ICP; display-only calls don't
    const refresh = !!body.refresh;
    // A company's live ads barely change day-to-day, and pulling them costs money/rate-limit (Jina).
    // So we DON'T re-pull on every visit: we keep the last successful pull durably (30d) and SHOW it
    // instantly. We only go live when the user hits Refresh, or the copy is older than a week (a soft
    // weekly re-check). And if a live pull fails, we keep showing the last copy — never an error or a
    // blank/sample board. `_checkedAt` on the cached object drives the "checked X ago" freshness.
    const FRESH_MS = 7 * 24 * 60 * 60 * 1000; // re-check at most ~once a week on entry
    const CACHE_TTL = 60 * 60 * 24 * 30;      // keep the last pull for 30 days (durable "last seen")

    // Load whatever we last saw for this company (any age).
    let cachedCopy = null;
    if (_redis && domKey) {
      try { const raw = await _redis.get(pullKey); cachedCopy = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch (e) {}
      if (!(cachedCopy && cachedCopy.ads && cachedCopy.ads.length)) cachedCopy = null;
    }
    const cacheAge = (cachedCopy && cachedCopy._checkedAt) ? (Date.now() - cachedCopy._checkedAt) : Infinity;
    const cacheFresh = !!cachedCopy && cacheAge < FRESH_MS;
    // Admin-only manual RE-SCORE: re-run the risk score on an already-pulled board on demand (the button
    // Marina sees). Uses the cached ad LIST (no re-pull) and forces a fresh score of every creative in
    // one call. Gated to admin so a prospect viewing a shared board can't trigger expensive re-scores.
    const adminRescore = !!body.rescore && await icpIsAdmin(req, _redis);

    // LinkedIn-only retry: Google and the ICP are already done, so "Retry LinkedIn" should re-pull ONLY
    // LinkedIn and merge it with the cached Google/Meta — not redo everything. Needs a cached copy to
    // merge into; without one we fall through to a normal full pull.
    if (refresh && body.only === 'linkedin' && cachedCopy) {
      const liPull = await fetchLinkedInAds({ company: body.company, domain: body.domain, limit: 12 }).catch(() => ({ ok: false, ads: [] }));
      const gotLi = !!(liPull.ok && liPull.ads && liPull.ads.length);
      const nonLi = (cachedCopy.ads || []).filter(a => (a.plat || '') !== 'LinkedIn');
      const liAds = gotLi ? liPull.ads : (cachedCopy.ads || []).filter(a => (a.plat || '') === 'LinkedIn'); // keep last-seen if still blocked
      const merged = {
        ok: true, ads: [...liAds, ...nonLi],
        sources: { ...(cachedCopy.sources || {}), linkedin: liAds.length },
        notes: { ...(cachedCopy.notes || {}), linkedin: gotLi ? 'ok' : (liPull.reason || 'no_ads'), linkedin_apify: liPull._apify || null },
        _checkedAt: Date.now(),
      };
      const scM = await scoreAdsCached(merged.ads, body.icp, _redis, { force: false, limit: 3 });
      merged.ads = dropJunkCreatives(scM.ads);
      if (_redis && domKey) { try { await _redis.set(pullKey, JSON.stringify(merged), { ex: CACHE_TTL }); } catch (e) {} }
      return res.status(200).json({ ...merged, fresh: { checked: Date.now(), checkedAt: merged._checkedAt, stale: false, listCached: false, count: merged.ads.length, scoredNew: scM.scoredNew, reused: scM.reused, pending: scM.pending, scoreError: scM.scoreError || null, rateLimited: !!scM.rateLimited } });
    }

    // Progressive first paint: a cold board's slow part is LinkedIn (Jina, ~30s); Google is fast (~3s).
    // On a fresh open the client asks for `only:'google'` FIRST so the board paints in seconds, then
    // does the normal full pull (LinkedIn included) behind it. This branch pulls + scores ONLY Google
    // and does NOT write the pull cache (the follow-up full pull writes the authoritative merged set),
    // so it never masks LinkedIn from the next pull. Per-creative scores ARE cached, so the full pull
    // reuses them for free.
    if (body.only === 'google') {
      const gg = await fetchGoogleAds({ domain: body.domain, company: body.company, limit: 12 }).catch(() => ({ ok: false, ads: [] }));
      const gads = dropJunkCreatives(gg.ads || []);
      if (!gads.length) return res.status(200).json({ ok: false, ads: [], _fast: true });
      if (!wantScore) return res.status(200).json({ ok: true, ads: gads, sources: { google: gads.length }, notes: { google: 'ok' }, _fast: true });
      const scG = await scoreAdsCached(gads, body.icp, _redis, { force: false, limit: 6 });
      const scGads = dropJunkCreatives(scG.ads);
      return res.status(200).json({ ok: true, ads: scGads, sources: { google: scGads.length }, notes: { google: 'ok' }, _fast: true, fresh: { checked: Date.now(), checkedAt: null, stale: false, listCached: false, count: scGads.length, scoredNew: scG.scoredNew, reused: scG.reused, pending: scG.pending, scoreError: scG.scoreError || null, rateLimited: !!scG.rateLimited } });
    }

    let pull = null, listCached = false, stale = false, lastChecked = null;
    if ((!refresh && cacheFresh) || (adminRescore && cachedCopy && cachedCopy.ads && cachedCopy.ads.length)) {
      // Fresh enough (< a week), OR an admin re-score: show the last-seen list instantly, no live pull.
      pull = cachedCopy; listCached = true; lastChecked = cachedCopy._checkedAt;
    } else {
      // Go live: the user asked to refresh, or the copy is stale (>1 week), or we've never pulled.
      const r = await fetchAllAds({ company: body.company, domain: body.domain });
      if (r && r.ok && r.ads && r.ads.length) {
        // Preserve last-seen ads PER PLATFORM: a pull that got Google but not LinkedIn (LinkedIn
        // flaky this run) must not wipe the LinkedIn ads we already had — otherwise the LinkedIn card
        // would flip back to an error. Carry forward each platform we lost from the previous copy.
        if (cachedCopy && Array.isArray(cachedCopy.ads)) {
          for (const plat of ['LinkedIn', 'Google']) {
            const gotNow = r.ads.some(a => (a.plat || '') === plat);
            if (!gotNow) {
              const prev = cachedCopy.ads.filter(a => (a.plat || '') === plat);
              if (prev.length) {
                r.ads = r.ads.concat(prev);
                r.sources = { ...(r.sources || {}), [plat.toLowerCase()]: prev.length };
                r.notes = { ...(r.notes || {}), [plat.toLowerCase()]: 'ok' }; // show the last seen, not an error
              }
            }
          }
        }
        r._checkedAt = Date.now();
        pull = r; lastChecked = r._checkedAt;
        if (_redis && domKey) { try { await _redis.set(pullKey, JSON.stringify(r), { ex: CACHE_TTL }); } catch (e) {} }
      } else if (cachedCopy) {
        // Live pull failed (LinkedIn/Jina unreachable) but we have a previous copy: SHOW IT, don't error.
        pull = cachedCopy; listCached = true; stale = true; lastChecked = cachedCopy._checkedAt;
      } else {
        // Nothing cached and the pull failed — genuinely nothing to show yet.
        return res.status(200).json(r || { ok: false, ads: [] });
      }
    }

    // Strip Google "collapsed ad" placeholders from whatever we're about to show (fresh OR a cached
    // copy from before this filter existed), so they never count toward "ads to fix" / "badly off".
    if (pull && Array.isArray(pull.ads)) pull.ads = dropJunkCreatives(pull.ads);

    // Layer B: score only the creatives we've never scored (new ads). Reuse the rest for free.
    // ALWAYS incremental (force:false), even on Refresh. Refresh re-pulls the LIST (so added ads get
    // scored and paused ones drop off), but it must NOT re-score every creative from scratch: with the
    // Sonnet scorer + 20 ads that one call blows Vercel's 60s limit, the function is killed, nothing is
    // saved and the user sees an error. Keeping the old scores and scoring only what's new stays well
    // under the limit. (A changed ICP still re-scores everything on its own, via the icpHash in the key.)
    if (!wantScore) return res.status(200).json({ ...pull, _listCached: listCached, _stale: stale, _checkedAt: lastChecked });
    // Cap new scoring per call so pull + Sonnet vision fits Vercel's 60s limit on a big fresh board.
    // `fresh.pending` tells the client how many creatives are still unscored; it re-calls ads-fetch
    // (list now cached, so no pull) to score the next batch until pending hits 0.
    // Fewer per call when this call also did the pull (~30s of the budget); more when the list was
    // served from cache (no pull, so almost the whole 60s is free for scoring).
    // Admin re-score forces a fresh score of every creative in one call (list is cached, so the whole
    // 60s budget is free for scoring); normal loads score incrementally and reuse cached scores.
    const sc = await scoreAdsCached(pull.ads, body.icp, _redis, { force: adminRescore, limit: adminRescore ? 0 : (listCached ? 8 : 3) });
    const scAds = dropJunkCreatives(sc.ads); // catch any blank only revealed by its scored verdict
    // Persist a compact stats snapshot for the link-preview image (og:image). The pull cache stores
    // UNSCORED ads, so the preview can't derive metrics from it; write the scored numbers + the worst
    // creative here, on every board render, so the shared card is always current. Cheap single set.
    if (_redis && domKey) {
      try {
        const scoredAll = scAds.filter(a => typeof a.score === 'number');
        if (scoredAll.length) {
          const worst = scoredAll.filter(a => a.img && /^https?:\/\//.test(String(a.img))).sort((a, b) => a.score - b.score)[0] || null;
          // Same numbers the board overview cards show, so the link preview mirrors them exactly:
          // off = ads reaching the wrong buyer (score <= 6, "ads to fix"), crit = badly off (<= 4).
          const cnt = scoredAll.length;
          const off = cnt - scoredAll.filter(a => a.score > 6).length;
          const crit = scoredAll.filter(a => a.score <= 4).length;
          const og = {
            count: cnt,
            avg: Math.round((scoredAll.reduce((s, a) => s + a.score, 0) / cnt) * 10) / 10,
            off,
            crit,
            offPct: Math.round(off / cnt * 100),
            toFix: crit, // legacy field
            worstImg: worst ? worst.img : null,
            worstPlat: worst ? (worst.plat || null) : null,
            at: Date.now(),
          };
          await _redis.set('ads:ogstats:' + domKey, JSON.stringify(og), { ex: 60 * 60 * 24 * 30 });
          // Clean, scored, non-artifact ads for the public GEO page (/b/<domain>), read by
          // _board-og. Excludes capture_fail (a wrong-advertiser or scrape artifact) so the
          // crawlable page never publishes an ad that isn't really this company's.
          // Belt-and-suspenders: also require the ad's advertiser to match this company, so a
          // stranger's ad that slipped past the pull-time filter (or an older contaminated cache)
          // never gets published publicly under this company's name.
          const ownScored = ownedByAdvertiser(
            scoredAll.filter(a => a.flag !== 'capture_fail' && (a.head || a.headline)),
            { domain: body.domain, company: body.company }
          );
          const geoAds = ownScored
            .slice(0, 24)
            .map(a => ({ head: String(a.head || a.headline).slice(0, 200), score: a.score, verdict: a.verdict ? String(a.verdict).slice(0, 200) : '', plat: a.plat || '' }));
          if (geoAds.length) await _redis.set('ads:geo:' + domKey, JSON.stringify(geoAds), { ex: 60 * 60 * 24 * 30 });
        }
      } catch (e) {}
    }
    return res.status(200).json({
      ...pull,
      ads: scAds,
      fresh: { checked: Date.now(), checkedAt: lastChecked, stale, listCached, count: scAds.length, scoredNew: sc.scoredNew, reused: sc.reused, pending: sc.pending, scoreError: sc.scoreError || null, rateLimited: !!sc.rateLimited },
    });
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
  // v2 (2026-09-12): bumped so boards regenerate their ICP under the richer, less-shrunk prompt
  // (multi-vertical, role-and-pain based). Regeneration is lazy per board on open, and because the
  // scores are keyed by a hash of the ICP, a changed ICP also re-scores that board (batched, safe).
  const icpCacheKey = `icp:v2:url:${urlHash}`;
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

  const systemPrompt = `You are a B2B go-to-market analyst. From a page, identify the advertiser company and infer its Ideal Customer Profile, the buyer its ads should target. Be concrete about the buyer role or roles, the account profile, the sweet-spot segments, and the core pain. Do not invent facts that contradict the content.

CAPTURE THE FULL BUYER, DO NOT SHRINK IT. The single most common mistake is collapsing a company that sells across several industries or buyer roles into one narrow persona (e.g. calling a CIAM platform that serves retail, ecommerce, finance, travel, healthcare, government and B2B partner portals just "SaaS companies"). That narrow ICP makes the company's legitimate vertical or segment ads look "off-target" and silently breaks every ad score. Instead: capture the buyer by their DEFINING SITUATION and PAIN (what they operate, what breaks, why they buy), not by a narrow industry guess; name the buyer ROLES the company actually sells to (several related titles when true, not one); and name the sweet-spot INDUSTRIES or SEGMENTS when the company clearly serves more than one, so a vertical-specific ad is judged on-target. Stay specific about the pain and the account profile so the ICP is broad in coverage but sharp in who it is, never generic. Match the ICP's breadth to the company's ACTUAL breadth: if the company genuinely sells to one narrow buyer, keep the ICP short and do NOT pad it with roles or segments it does not serve. Only expand when the page shows real breadth. Length should follow substance, one dense sentence for a focused company, more only when the buyer universe truly is wider.

The page may be the company's own website, OR an ad-library / ad-transparency page (Meta, Google, or LinkedIn) that shows one of the company's ads. If it is an ad-library page, identify the advertiser from the content and infer their real company website.

NEVER name a CDN, hosting, security, or anti-bot provider (Cloudflare, Akamai, Fastly, Imperva, Vercel, AWS, etc.) as the advertiser just because the page mentions it or is served by it, that is infrastructure, not the company being advertised. If the page content is missing, thin, or a bot-check / "just a moment" / access-denied interstitial so you cannot actually tell who the advertiser is, do NOT guess a specific company: return "company" and "website" as empty strings, keep "summary"/"icp_text"/"tags" generic (a plausible B2B buyer the user can correct), and never fabricate a well-known brand.

Return ONLY valid JSON. No markdown, no backticks, no text before or after. Exact shape:
{
  "company": "the advertiser company name",
  "website": "the company's own website as a full https:// URL (best guess)",
  "summary": "2-3 sentences on who this company sells to (roles and segments) and the pain those buyers feel",
  "icp_text": "one to three sentences that capture the REAL buyer: the buyer role or roles (several related titles if the company sells to more than one), the defining account situation or firmographic that makes a company a fit (what they operate, size, model), the sweet-spot industries or segments when the company clearly serves several (name them, do not collapse a multi-vertical seller into one narrow label), and the core pain or trigger that makes them buy. Lead with the defining characteristic and pain, not a narrow industry guess. Only mention ad spend if the page actually signals it.",
  "tags": ["4-6 short chips: mix buyer roles and sweet-spot segments, like 'CISOs', 'Head of Identity', 'Retail & ecommerce', 'Enterprise', 'Legacy CIAM replacement'"]
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
        // temperature 0: ICP detection must be deterministic. The board scores every ad
        // AGAINST this ICP, so a drifting ICP silently drifts all the scores (the same
        // unchanged Semgrep ad swung 5 -> 7 between loads just because the re-detected buyer
        // came back slightly different). Pin it so a given site always yields the same buyer
        // and therefore the same, reproducible scores. Mirrors scoreAds() which is already 0.
        temperature: 0,
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
