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

export async function boardOgHandler(req, res) {
  const slug = (req.query && (req.query.slug || req.query.s)) || '';
  let html = await getShell();
  try {
    if (!html) { res.setHeader('Location', '/'); res.status(302).end(); return; }
    const domain = slugToDomain(slug);
    if (!domain) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(html); return; }

    const company = nameFromDomain(domain);
    const boardUrl = 'https://www.adroast.in/b/' + encodeURIComponent(slug);

    // Enrich with real board stats when the pull is cached (free, no model call).
    let stats = null, ads = [];
    if (_redis) {
      try {
        const domKey = domain.replace(/[^a-z0-9.]/g, '');
        const raw = await _redis.get('ads:pull:' + domKey);
        const pull = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        ads = pull && Array.isArray(pull.ads) ? pull.ads : [];
        stats = ads.length ? boardStats(ads) : null;
      } catch (e) { stats = null; ads = []; }
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

    // Per-company og:image: a 1200x630 PNG rendered for THIS company (name + live board stats) by
    // /api/icp?ogimg=1 (satori + resvg-wasm). Falls back to the static hero on any render error.
    const imgUrl = 'https://www.adroast.in/api/icp?ogimg=1&slug=' + encodeURIComponent(slug);
    html = replaceTag(html, /(<meta property="og:image" content=")[^"]*(">)/, `$1${attr(imgUrl)}$2`);
    html = replaceTag(html, /(<meta name="twitter:image" content=")[^"]*(">)/, `$1${attr(imgUrl)}$2`);
    html = replaceTag(html, /(<meta property="og:image:alt" content=")[^"]*(">)/, `$1${attr('Where ' + company + "'s ads lose the buyer")}$2`);

    // GEO (generative-engine optimization): inject real, crawlable body content plus
    // JSON-LD so LLM crawlers (GPTBot, PerplexityBot, ClaudeBot) and search bots read
    // a substantive page, not an empty SPA shell. React calls createRoot(#root).render
    // on mount, which REPLACES this markup, so real (JS) users never see it, only the
    // no-JS crawler does. Injected ONLY when the company has real scored ads, so a
    // company with nothing to say never produces a thin page.
    const listable = ads.filter(a => a && (a.head || a.headline));
    if (listable.length > 0) {
      const items = listable.slice(0, 20).map(a => {
        const h = attr(a.head || a.headline);
        const sc = (typeof a.score === 'number') ? ` &mdash; scored ${a.score}/10 against ${attr(company)}&rsquo;s ideal buyer` : '';
        const v = a.verdict ? '. ' + attr(String(a.verdict)) : '';
        return `<li><strong>${h}</strong>${sc}${v}</li>`;
      }).join('');
      const statLine = stats ? ` Their average fit to their own ideal buyer is ${stats.avg} out of 10, and ${stats.toFix === 1 ? '1 ad needs fixing' : stats.toFix + ' ads need fixing'}.` : '';
      const intro = `${attr(company)} is running ${listable.length} live ads on LinkedIn and Google.${statLine} Each ad below is one of ${attr(company)}&rsquo;s real live creatives, read straight from the ad libraries.`;
      const content = '<main style="max-width:720px;margin:0 auto;padding:40px 20px;font-family:system-ui,-apple-system,sans-serif;color:#1f2937;line-height:1.65">'
        + `<h1 style="font-size:26px;font-weight:600;letter-spacing:-.3px">${attr(title)}</h1>`
        + `<p>${intro}</p>`
        + `<h2 style="font-size:18px;font-weight:600;margin-top:26px">${attr(company)}&rsquo;s live ads, scored against their buyer</h2>`
        + `<ul>${items}</ul>`
        + `<p><a href="/b/${attr(slug)}">See ${attr(company)}&rsquo;s full live-ad board on AdRoast</a> &mdash; every creative scored against their ICP, with the exact fix for each.</p>`
        + '</main>';
      html = html.replace('<div id="root"></div>', '<div id="root">' + content + '</div>');
      const ld = {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: title,
        description: desc,
        url: boardUrl,
        about: { '@type': 'Organization', name: company, url: 'https://' + domain }
      };
      const ldScript = '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>';
      html = html.replace('</head>', ldScript + '</head>');
    }

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
