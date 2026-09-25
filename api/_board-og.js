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
    // Canonical form is the normalized domain (the sitemap lists /b/<domain>), so /b/wiz,
    // /b/Wiz.io and /board/wiz.io all consolidate on one indexable URL.
    const boardUrl = 'https://www.adroast.in/b/' + encodeURIComponent(domain);

    // Enrich with real board stats when the pull is cached (free, no model call).
    // Read the CLEAN, scored, non-artifact ad list persisted for GEO (ads:geo), not the
    // raw pull: the raw list can hold capture artifacts and other advertisers' creatives
    // that the board only filters out AFTER scoring, so publishing it would show wrong ads.
    let stats = null, ads = [], posdata = null;
    if (_redis) {
      try {
        const domKey = domain.replace(/[^a-z0-9.]/g, '');
        const raw = await _redis.get('ads:geo:' + domKey);
        const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        ads = Array.isArray(list) ? list : [];
        stats = ads.length ? boardStats(ads) : null;
        // No clean ads: fall back to the positioning record so a company with no readable
        // live ads still gets a crawlable page (GEO phase 2).
        if (!ads.length) {
          const pr = await _redis.get('geo:icp:' + domKey);
          posdata = pr ? (typeof pr === 'string' ? JSON.parse(pr) : pr) : null;
        }
      } catch (e) { stats = null; ads = []; posdata = null; }
    }

    const title = 'Where ' + company + "'s ads lose the buyer";
    const desc = stats
      ? company + "'s live LinkedIn and Google ads, each scored against their ideal buyer. " + stats.count + ' live ads, ' + stats.avg + '/10 average fit, ' + stats.toFix + ' to fix. See the board.'
      : company + "'s live LinkedIn and Google ads, each scored against their ideal buyer, with the exact fixes. Free, no card.";

    // Search-engine identity of the page: without these the board ships the home's <title>,
    // meta description and canonical (https://www.adroast.in/), so Google folds every board into
    // the home as a duplicate and never indexes it. Board-specific, self-canonical.
    const docTitle = company + ' LinkedIn & Google ads, scored against their buyer | AdRoast';
    html = replaceTag(html, /<title>[^<]*<\/title>/, `<title>${attr(docTitle)}</title>`);
    html = replaceTag(html, /(<meta name="description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);
    html = replaceTag(html, /(<link rel="canonical" href=")[^"]*(">)/, `$1${attr(boardUrl)}$2`);

    html = replaceTag(html, /(<meta property="og:title" content=")[^"]*(">)/, `$1${attr(title)}$2`);
    html = replaceTag(html, /(<meta property="og:description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);
    html = replaceTag(html, /(<meta property="og:url" content=")[^"]*(">)/, `$1${attr(boardUrl)}$2`);
    html = replaceTag(html, /(<meta name="twitter:title" content=")[^"]*(">)/, `$1${attr(title)}$2`);
    html = replaceTag(html, /(<meta name="twitter:description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);

    // Per-company og:image: a 1200x630 PNG rendered for THIS company (name + live board stats) by
    // /api/icp?ogimg=1 (satori + resvg-wasm). Falls back to the static hero on any render error.
    const imgUrl = 'https://www.adroast.in/api/icp?ogimg=1&slug=' + encodeURIComponent(slug);
    html = replaceTag(html, /(<meta property="og:image" content=")[^"]*(">)/, `$1${attr(imgUrl)}$2`);
    // LinkedIn and Slack prefer og:image:secure_url when both are present, so leaving it
    // on the static card silently served the generic image for every board.
    html = replaceTag(html, /(<meta property="og:image:secure_url" content=")[^"]*(">)/, `$1${attr(imgUrl)}$2`);
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
        const sc = (typeof a.score === 'number') ? `, scored ${a.score}/10 against ${attr(company)}&rsquo;s ideal buyer` : '';
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
        + `<p><a href="/b/${attr(slug)}">See ${attr(company)}&rsquo;s full live-ad board on AdRoast</a>. Every creative scored against their ICP, with the exact fix for each.</p>`
        + `<p>Learn the method behind these scores: the AdRoast <a href="/guides">guides</a> cover how to <a href="/guides/audit-linkedin-ads-icp">audit your ads against your ICP</a> and why <a href="/guides/clicks-no-pipeline">clicks do not turn into pipeline</a>.</p>`
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
    } else if (posdata && posdata.company) {
      // GEO phase 2: no readable live ads, so render a positioning page (who they sell to)
      // instead, keeping a crawlable, citable page for a company with no ad footprint.
      const comp = attr(posdata.company);
      const tagList = Array.isArray(posdata.tags) ? posdata.tags.filter(Boolean).slice(0, 8) : [];
      const content = '<main style="max-width:720px;margin:0 auto;padding:40px 20px;font-family:system-ui,-apple-system,sans-serif;color:#1f2937;line-height:1.65">'
        + `<h1 style="font-size:26px;font-weight:600;letter-spacing:-.3px">${comp}: who they sell to, and their live ad presence</h1>`
        + (posdata.summary ? `<p>${attr(posdata.summary)}</p>` : '')
        + (posdata.icp_text ? `<h2 style="font-size:18px;font-weight:600;margin-top:26px">Who ${comp} sells to</h2><p>${attr(posdata.icp_text)}</p>` : '')
        + (tagList.length ? `<h2 style="font-size:18px;font-weight:600;margin-top:26px">Buyer and segments</h2><ul>${tagList.map(t => `<li>${attr(t)}</li>`).join('')}</ul>` : '')
        + `<h2 style="font-size:18px;font-weight:600;margin-top:26px">Live ad presence</h2><p>We checked the LinkedIn and Google ad libraries and found no live ads we can read for ${comp} right now. When they run ads, AdRoast scores each one against the buyer above.</p>`
        + `<p><a href="/b/${attr(slug)}">Score ${comp}&rsquo;s ads against this buyer on AdRoast</a>.</p>`
        + `<p>Learn the method: the AdRoast <a href="/guides">guides</a> cover how to <a href="/guides/audit-linkedin-ads-icp">audit ads against your ICP</a> and how to <a href="/guides/what-is-an-ad-teardown">run an ad teardown</a>.</p>`
        + '</main>';
      html = html.replace('<div id="root"></div>', '<div id="root">' + content + '</div>');
      const ld = { '@context': 'https://schema.org', '@type': 'Organization', name: posdata.company, url: posdata.website || ('https://' + domain), description: posdata.summary || posdata.icp_text || '' };
      const ldScript = '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>';
      html = html.replace('</head>', ldScript + '</head>');
    }

    // Nothing real to show (no clean ads, no positioning record): keep it out of the index so an
    // arbitrary /b/<anything> never becomes a thin indexed page. Humans still get the app.
    if (!listable.length && !(posdata && posdata.company)) {
      html = html.replace('</head>', '<meta name="robots" content="noindex, follow"></head>');
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
