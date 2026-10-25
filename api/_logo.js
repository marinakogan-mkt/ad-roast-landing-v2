// Server-side logo resolver. The only source of truth for "the company's logo" is the
// company's OWN site: a site declares its brand in the HTML head (apple-touch-icon, rel=icon,
// schema.org Organization.logo, og:image). Sourced from there, the logo matches the site by
// construction, no per-domain list to maintain. The browser can't read another domain's HTML
// (CORS blocks it), so this MUST run server-side; that's why the board can't do it in the front
// and has to call /api/icp?logo=<domain>. Logo.dev + Google favicon stay as the safety net for
// sites that are down, block the fetch, or declare nothing. The declared list is cached in Redis
// (30d) so the HTML is fetched at most once per domain.
import { Redis } from '@upstash/redis';

// Logo.dev PUBLISHABLE token (pk_...): safe in client + server code, like a Maps key.
export const LOGO_DEV_TOKEN = 'pk_EEohEWP8R0a7wQQ9I8FFzw';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const DECLARED_TTL = 60 * 60 * 24 * 30; // 30 days

let _redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
} catch (e) { _redis = null; }

export function normDomain(input) {
  return String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').split(':')[0];
}

// The always-available safety net, in quality order: Logo.dev's brand logo, then Google's favicon.
export function fallbackLogoUrls(domain) {
  const d = normDomain(domain);
  if (!d) return [];
  return [
    'https://img.logo.dev/' + d + '?token=' + LOGO_DEV_TOKEN + '&size=200&format=png&retina=true',
    'https://www.google.com/s2/favicons?sz=128&domain=' + d,
  ];
}

// Parse the site's <head> for the logos it declares, split into two tiers so a caller can rank
// Logo.dev's brand mark BETWEEN them (see logoCandidates):
//   STRONG (the real brand mark): 1. apple-touch-icon (clean 180x180 PNG)  2. schema.org Organization.logo
//   WEAK   (often tiny / not the logo): 3. rel="icon"/"shortcut icon" favicon  4. og:image social banner
// A bare 32px favicon is worse than Logo.dev's 400px logo, so it must NOT win just for being declared.
export function extractDeclaredLogos(html, baseUrl) {
  const strong = [];
  const weak = [];
  let base;
  try { base = new URL(baseUrl); } catch (e) { return { strong, weak }; }
  // href values in HTML attributes are entity-encoded (e.g. ?w=180&amp;h=180). Decode the few
  // entities that legally appear in a URL before parsing, or the query string breaks on fetch.
  const deEntity = (s) => String(s || '').replace(/&amp;/gi, '&').replace(/&#(?:38|x26);/gi, '&').replace(/&#(?:47|x2f);/gi, '/');
  const abs = (href) => { try { return new URL(deEntity((href || '').trim()), base).toString(); } catch { return null; } };
  const head = String(html || '').slice(0, 200000); // the head is all we need; cap for safety

  const links = head.match(/<link\b[^>]*>/gi) || [];
  const relOf = (t) => (t.match(/\brel=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
  const hrefOf = (t) => t.match(/\bhref=["']([^"']+)["']/i)?.[1] || '';
  const sizeOf = (t) => { const n = parseInt(t.match(/\bsizes=["']([^"']+)["']/i)?.[1] || '', 10); return isNaN(n) ? 0 : n; };
  const seen = new Set();
  const push = (arr, u) => { if (u && !seen.has(u)) { seen.add(u); arr.push(u); } };

  // 1. apple-touch-icon(-precomposed), largest declared size first -> STRONG
  links.filter((t) => /apple-touch-icon/.test(relOf(t)))
    .map((t) => ({ url: abs(hrefOf(t)), size: sizeOf(t) || 180 }))
    .filter((x) => x.url).sort((a, b) => b.size - a.size)
    .forEach((x) => push(strong, x.url));

  // 2. schema.org Organization.logo (from any JSON-LD block) -> STRONG
  const ld = head.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ld) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
    try {
      const data = JSON.parse(json);
      const nodes = Array.isArray(data) ? data : (Array.isArray(data['@graph']) ? data['@graph'] : [data]);
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const logo = node.logo;
        const url = typeof logo === 'string' ? logo : (logo && (logo.url || logo['@id']));
        if (url) push(strong, abs(url));
      }
    } catch (e) { /* malformed JSON-LD: skip */ }
  }

  // 3. rel="icon" / "shortcut icon" favicon, largest declared size first -> WEAK
  links.filter((t) => /(^|\s)icon(\s|$)|shortcut icon/.test(relOf(t)))
    .map((t) => ({ url: abs(hrefOf(t)), size: sizeOf(t) }))
    .filter((x) => x.url).sort((a, b) => b.size - a.size)
    .forEach((x) => push(weak, x.url));

  // 4. og:image (last resort) -> WEAK
  const og = head.match(/<meta[^>]*property=["']og:image(?::url)?["'][^>]*content=["']([^"']+)["']/i)?.[1]
    || head.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::url)?["']/i)?.[1];
  if (og) push(weak, abs(og));

  return { strong, weak };
}

async function fetchHomeHtml(domain) {
  for (const url of ['https://' + domain + '/', 'https://www.' + domain + '/']) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 7000);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow', signal: c.signal,
      });
      if (r.ok) { const html = await r.text(); if (html && html.length > 40) return html; }
    } catch (e) { /* try next */ } finally { clearTimeout(t); }
  }
  return null;
}

// The logos this domain declares on its own site, cached (30d). [] if the site is down/blocked/
// declares nothing — callers then fall back to fallbackLogoUrls(). refresh:true forces a re-fetch.
export async function declaredLogoUrls(domain, { refresh = false } = {}) {
  const d = normDomain(domain);
  if (!d) return { strong: [], weak: [] };
  const key = 'logo:declared:v2:' + d; // v2: {strong, weak} split (v1 cached a flat array)
  if (_redis && !refresh) {
    try { const c = await _redis.get(key); if (c != null) { const v = typeof c === 'string' ? JSON.parse(c) : c; if (v && Array.isArray(v.strong) && Array.isArray(v.weak)) return v; } } catch (e) {}
  }
  let logos = { strong: [], weak: [] };
  try {
    const html = await fetchHomeHtml(d);
    if (html) logos = extractDeclaredLogos(html, 'https://' + d + '/');
  } catch (e) { logos = { strong: [], weak: [] }; }
  if (_redis) { try { await _redis.set(key, JSON.stringify(logos), { ex: DECLARED_TTL }); } catch (e) {} }
  return logos;
}

// The full ordered candidate list for a domain. Strong declared marks (apple-touch-icon / schema.org
// logo) first; then Logo.dev's brand logo, which beats a tiny declared favicon (cycode/semgrep declare
// only a 32px favicon, so without this they resolved to a pixelated icon while Logo.dev had a 400px
// logo); then the weak declared sources (favicon / og:image); Google's favicon as the final net.
export async function logoCandidates(domain, opts) {
  const { strong, weak } = await declaredLogoUrls(domain, opts);
  const [logoDev, googleFav] = fallbackLogoUrls(domain);
  return [...strong, ...(logoDev ? [logoDev] : []), ...weak, ...(googleFav ? [googleFav] : [])];
}
