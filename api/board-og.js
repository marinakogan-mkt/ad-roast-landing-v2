// Per-company Open Graph for /b/<slug> (and /board/<slug>). A link shared on LinkedIn shows a card
// built from the OG tags in the served HTML, and the crawler does NOT run JS, so a personalized card
// (about THAT company's board, not the generic AdRoast card) has to be rendered server-side. This
// function serves the same SPA shell with the og:/twitter: tags rewritten for the company, so real
// users still get the app and boot normally, while the crawler reads the company-specific card.
// Any failure falls back to the untouched shell, so the board can never break from this.
import fs from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';

let _redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
} catch (e) { _redis = null; }

// Cache the shell in memory across warm invocations. Disk first (the built index.html ships with the
// deployment); if that ever fails, fetch the static root of the same site (which serves index.html).
let _shell = null;
async function getShell() {
  if (_shell) return _shell;
  for (const p of [path.join(process.cwd(), 'index.html'), '/var/task/index.html']) {
    try { const s = fs.readFileSync(p, 'utf8'); if (s && s.length > 500) { _shell = s; return _shell; } } catch (e) {}
  }
  try {
    const r = await fetch('https://www.adroast.in/', { headers: { 'x-og-bypass': '1' } });
    const s = await r.text();
    if (s && s.length > 500) { _shell = s; return _shell; }
  } catch (e) {}
  return null;
}

const attr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// slug -> domain: mirrors the client's expandDom (a dot-less slug is a .com; anything with a dot is
// already a domain). Then a display name from the first label ("softr.io" -> "Softr").
function slugToDomain(slug) {
  let s = String(slug || '').trim().toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
  s = s.split(/[/?#]/)[0];
  if (!s) return '';
  return s.indexOf('.') === -1 ? s + '.com' : s;
}
function nameFromDomain(domain) {
  const label = String(domain || '').split('.')[0].replace(/[^a-z0-9]+/gi, ' ').trim();
  if (!label) return 'This company';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Same demand-gen exclusions the board uses, so the headline stats match what the CMO sees.
function boardStats(ads) {
  const scored = (ads || []).filter(a => typeof a.score === 'number');
  if (!scored.length) return null;
  const avg = scored.reduce((s, a) => s + a.score, 0) / scored.length;
  const toFix = scored.filter(a => a.score <= 4).length;
  return { count: scored.length, avg: Math.round(avg * 10) / 10, toFix };
}

function replaceTag(html, re, value) {
  return re.test(html) ? html.replace(re, value) : html;
}

export default async function handler(req, res) {
  const slug = (req.query && (req.query.slug || req.query.s)) || '';
  let html = await getShell();
  try {
    if (!html) { res.setHeader('Location', '/'); res.status(302).end(); return; }
    const domain = slugToDomain(slug);
    if (!domain) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(html); return; }

    const company = nameFromDomain(domain);
    const boardUrl = 'https://www.adroast.in/b/' + encodeURIComponent(slug);

    // Enrich with real board stats when the pull is cached (free, no model call).
    let stats = null;
    if (_redis) {
      try {
        const domKey = domain.replace(/[^a-z0-9.]/g, '');
        const raw = await _redis.get('ads:pull:' + domKey);
        const pull = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        stats = pull && pull.ads ? boardStats(pull.ads) : null;
      } catch (e) { stats = null; }
    }

    const title = 'Where ' + company + "'s ads lose the buyer";
    const desc = stats
      ? company + "'s live LinkedIn and Google ads, each scored against their ideal buyer. " + stats.count + ' live ads, ' + stats.avg + '/10 average fit, ' + stats.toFix + ' to fix. See the board.'
      : company + "'s live LinkedIn and Google ads, each scored against their ideal buyer, with the exact fixes. Free, no card.";

    html = replaceTag(html, /(<meta property="og:title" content=")[^"]*(">)/, `$1${attr(title)}$2`);
    html = replaceTag(html, /(<meta property="og:description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);
    html = replaceTag(html, /(<meta property="og:url" content=")[^"]*(">)/, `$1${attr(boardUrl)}$2`);
    html = replaceTag(html, /(<meta name="twitter:title" content=")[^"]*(">)/, `$1${attr(title)}$2`);
    html = replaceTag(html, /(<meta name="twitter:description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);
    // og:image left as the branded AdRoast card for now (per-company image is a follow-up).

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Let the crawler and CDN cache the personalized shell briefly; stats refresh within the hour.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(html);
  } catch (e) {
    // Never break the board: serve the plain shell on any error.
    if (html) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(html); }
    else { res.setHeader('Location', '/'); res.status(302).end(); }
  }
}
