// Per-company link-preview IMAGE for /b/<slug> (og:image), rendered on demand as a 1200x630 PNG.
// A card shared on LinkedIn shows the image referenced by og:image; _board-og.js points that tag at
// /api/icp?ogimg=1&slug=<slug>, which lands here. We render a branded card for THAT company: AdRoast
// branding (light, not black), the company's own logo, one of their real creatives, and their board
// metrics as the biggest element. No headline text (the shared link's og:title already says it).
//
// WHY hand-built SVG + resvg-wasm (not @vercel/og, not satori): both @vercel/og and satori pull in
// harfbuzzjs, whose hb.wasm cannot be bundled into a Vercel Node function (nft misses it and the pnpm
// symlink layout defeats includeFiles), so both throw at runtime here. @resvg/resvg-wasm is a single
// self-contained wasm (no harfbuzz) that does its own text layout, and it bundles cleanly from
// api/_assets. So we compose the card as an SVG string ourselves (fixed layout) and let resvg
// rasterize it with the Inter TTFs we ship. .mjs so it loads as ESM (resvg-wasm is ESM-only). Imported
// dynamically from icp.js so none of it loads on the normal ICP/scoring path. Any failure redirects to
// the static hero, so the card can never break.
import fs from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

let _redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
} catch (e) { _redis = null; }

// Locate a bundled asset. Read via process.cwd() (like _board-og.js reads index.html); Vercel bundles
// the function to CommonJS where new URL(import.meta.url) is a syntax error, and vercel.json's
// functions.includeFiles ships api/_assets/** into the function so these are on disk.
function assetPath(name) {
  for (const base of [path.join(process.cwd(), 'api', '_assets'), '/var/task/api/_assets']) {
    try { const p = path.join(base, name); if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return path.join(process.cwd(), 'api', '_assets', name); // let readFileSync throw a clear ENOENT
}

let _fonts = null;
function loadFonts() {
  if (_fonts) return _fonts;
  _fonts = [fs.readFileSync(assetPath('inter-regular.ttf')), fs.readFileSync(assetPath('inter-bold.ttf'))];
  return _fonts;
}

// AdRoast brand mark (the blue "in" + flame icon), inlined as a data URI so it embeds in the SVG.
let _adLogo;
function adLogoDataUri() {
  if (_adLogo !== undefined) return _adLogo;
  try { _adLogo = 'data:image/png;base64,' + fs.readFileSync(assetPath('adroast-logo.png')).toString('base64'); }
  catch (e) { _adLogo = ''; }
  return _adLogo;
}

// initWasm must run exactly once per process; cache the promise so concurrent requests share it.
let _wasmReady = null;
function ensureWasm() {
  if (!_wasmReady) {
    const bytes = fs.readFileSync(assetPath('resvg.wasm'));
    _wasmReady = initWasm(bytes).catch((e) => {
      if (!/already/i.test(String(e && e.message))) { _wasmReady = null; throw e; }
    });
  }
  return _wasmReady;
}

// slug -> domain -> display name, mirroring _board-og.js (a dot-less slug is a .com).
function slugToDomain(slug) {
  let s = String(slug || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.png$/, '').replace(/\/+$/, '');
  s = s.split(/[/?#]/)[0];
  if (!s) return '';
  return s.indexOf('.') === -1 ? s + '.com' : s;
}
function nameFromDomain(domain) {
  const label = String(domain || '').split('.')[0].replace(/[^a-z0-9]+/gi, ' ').trim();
  if (!label) return 'This company';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// The same Google "collapsed ad" placeholder guard the board uses, inlined so this generator stays
// self-contained (it must never throw). Keeps a blank slot out of the stats and off the creative.
function isJunk(a) {
  if (!a) return true;
  const id = (String(a.img || '').match(/simgad\/(\d+)/) || [])[1];
  if (id === '6364307266515146391') return true;
  const t = (String(a.title || a.head || '') + ' ' + String(a.verdict || '')).toLowerCase();
  return /collapsed ad on|empty ad slot|nothing to show|more_vert/.test(t);
}
function boardStats(ads) {
  const scored = (ads || []).filter(a => typeof a.score === 'number' && !isJunk(a));
  if (!scored.length) return null;
  const cnt = scored.length;
  const off = cnt - scored.filter(a => a.score > 6).length; // reaching the wrong buyer (score <= 6)
  const crit = scored.filter(a => a.score <= 4).length;      // badly off (<= 4)
  const avg = Math.round((scored.reduce((s, a) => s + a.score, 0) / cnt) * 10) / 10;
  return { count: cnt, avg, off, crit, offPct: Math.round(off / cnt * 100) };
}
// The single ad we spotlight in the preview: the worst-scoring one with a usable creative (the same
// "start here" ad the board recommends). Returns the ad or null.
function worstCreative(ads) {
  const withImg = (ads || []).filter(a => typeof a.score === 'number' && a.img && /^https?:\/\//.test(String(a.img)) && !isJunk(a));
  if (!withImg.length) return null;
  return withImg.slice().sort((a, b) => a.score - b.score)[0];
}

// Fetch a remote image and return a data URI resvg can embed (png/jpeg/gif only; skip webp/svg which
// resvg-wasm won't reliably raster). Short timeout + size cap; any problem returns null so the card
// simply omits that piece instead of failing.
async function fetchDataUri(url, headers) {
  if (!url) return null;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 4500);
    let r;
    try { r = await fetch(url, { signal: c.signal, headers: headers || {}, redirect: 'follow' }); } finally { clearTimeout(t); }
    if (!r || !r.ok) return null;
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|jpg|gif)$/.test(ct)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 3500000) return null;
    return 'data:' + ct + ';base64,' + buf.toString('base64');
  } catch (e) { return null; }
}
async function firstDataUri(urls, headers) {
  for (const u of urls) { const d = await fetchDataUri(u, headers); if (d) return d; }
  return null;
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const LOGO_DEV_TOKEN = 'pk_EEohEWP8R0a7wQQ9I8FFzw';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Palette — AdRoast branding, light.
const BLUE = '#0a66c2';
const INK = '#0f1b2d';
const MUTE = '#64748b';
const LINE = '#e2e8f0';
const PANEL = '#f1f6fc';
const RED = '#dc2626';
const AMBER = '#b45309';
const GREEN = '#15803d';
// score -> color, matching the board's severity read (red badly off, amber weak, blue solid).
const scoreColor = (s) => (s <= 4 ? RED : s <= 6 ? '#d97706' : BLUE);

// The board's two overview cards, mirrored here so the link preview shows the same chips.
function sevAdsToFix(offPct, crit) {
  return (offPct >= 30 || crit >= 2) ? { t: 'Losing the buyer', c: RED }
    : (offPct >= 10 || crit >= 1) ? { t: 'Missing the buyer', c: AMBER }
    : offPct > 0 ? { t: 'Minor misses', c: AMBER }
    : { t: 'On target', c: GREEN };
}
function sevOffTarget(offPct) {
  return offPct >= 30 ? { t: 'Mostly off target', c: RED }
    : offPct >= 15 ? { t: 'Off target', c: RED }
    : offPct >= 5 ? { t: 'Some off target', c: AMBER }
    : offPct > 0 ? { t: 'A few off target', c: AMBER }
    : { t: 'All on target', c: GREEN };
}
// tint a hex color at low alpha for chip/card fills (color + "14"/"33" like the board's tailwind).
const tint = (hex, aa) => hex + aa;

// Simple deterministic brand color for the monogram fallback when no logo image resolves.
function monoColor(seed) {
  let h = 0; const str = String(seed || 'a');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hues = ['#0a66c2', '#2563eb', '#7c3aed', '#0891b2', '#db2777', '#ea580c', '#059669'];
  return hues[h % hues.length];
}

// One big metric inside a soft tinted panel (board-card language): huge value + short unit, optional
// progress bar. Minimal words so it stays legible at a small feed thumbnail; the tint carries urgency.
function metricPanel(x, y, w, h, color, value, unit, barPct) {
  const b = [];
  b.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${color}14" stroke="${color}30" stroke-width="1.5"/>`);
  const vy = y + (typeof barPct === 'number' ? 76 : Math.round(h * 0.5) + 28);
  b.push(`<text x="${x + 28}" y="${vy}" font-family="Inter" font-size="84" font-weight="700" fill="${color}">${esc(value)}<tspan font-size="40" font-weight="700" fill="${INK}" dx="16">${esc(unit)}</tspan></text>`);
  if (typeof barPct === 'number') {
    const bx = x + 28, by = vy + 26, bw = w - 56;
    b.push(`<rect x="${bx}" y="${by}" width="${bw}" height="12" rx="6" fill="#ffffff" stroke="${color}22" stroke-width="1"/>`);
    b.push(`<rect x="${bx}" y="${by}" width="${Math.round(bw * Math.max(0, Math.min(100, barPct)) / 100)}" height="12" rx="6" fill="${color}"/>`);
  }
  return b.join('');
}

function buildSvg(opts) {
  const { company, domain, stats, adLogo, coLogo, creative } = opts;
  const parts = [];
  parts.push(`<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`);
  parts.push(`<defs>`);
  parts.push(`<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3f8fe"/><stop offset="1" stop-color="#e7eff9"/></linearGradient>`);
  parts.push(`<clipPath id="clogo"><rect x="84" y="146" width="68" height="68" rx="15"/></clipPath>`);
  parts.push(`<clipPath id="ccrea"><rect x="700" y="146" width="420" height="396" rx="20"/></clipPath>`);
  parts.push(`</defs>`);

  // Soft branded ground + a white "report card" inset (with a faint drop shadow) so it feels designed.
  parts.push(`<rect width="1200" height="630" fill="url(#bg)"/>`);
  parts.push(`<rect x="40" y="46" width="1120" height="556" rx="30" fill="#0f1b2d" opacity="0.06"/>`);
  parts.push(`<rect x="40" y="38" width="1120" height="556" rx="30" fill="#ffffff" stroke="#e6ebf2" stroke-width="1.5"/>`);

  // Brand row: AdRoast logo + wordmark.
  if (adLogo) parts.push(`<image x="84" y="70" width="42" height="42" xlink:href="${adLogo}" href="${adLogo}"/>`);
  parts.push(`<text x="${adLogo ? 136 : 84}" y="100" font-family="Inter" font-size="27" font-weight="700" fill="${BLUE}">AdRoast</text>`);

  // Company row: their logo (or monogram) + name.
  if (coLogo) {
    parts.push(`<rect x="84" y="146" width="68" height="68" rx="15" fill="#ffffff" stroke="${LINE}" stroke-width="1.5"/>`);
    parts.push(`<image x="84" y="146" width="68" height="68" clip-path="url(#clogo)" preserveAspectRatio="xMidYMid meet" xlink:href="${coLogo}" href="${coLogo}"/>`);
  } else {
    const c = monoColor(domain || company);
    parts.push(`<rect x="84" y="146" width="68" height="68" rx="15" fill="${c}"/>`);
    parts.push(`<text x="118" y="194" font-family="Inter" font-size="36" font-weight="700" fill="#ffffff" text-anchor="middle">${esc((company || '?').charAt(0).toUpperCase())}</text>`);
  }
  const n = (company || '').length;
  const nameSize = n <= 10 ? 58 : n <= 16 ? 50 : n <= 24 ? 40 : 32;
  const nameY = 180 + Math.round(nameSize * 0.35); // vertically centered against the 68px logo
  parts.push(`<text x="170" y="${nameY}" font-family="Inter" font-size="${nameSize}" font-weight="700" fill="${INK}">${esc(company)}</text>`);

  // The two board metrics, big, in tinted panels (stacked, left column).
  if (stats) {
    const s1 = sevAdsToFix(stats.offPct, stats.crit);
    const s2 = sevOffTarget(stats.offPct);
    parts.push(metricPanel(84, 300, 560, 112, s1.c, String(stats.off), stats.off === 1 ? 'ad to fix' : 'ads to fix'));
    parts.push(metricPanel(84, 428, 560, 150, s2.c, stats.offPct + '%', 'off-target', stats.offPct));
  } else {
    parts.push(`<text x="84" y="370" font-family="Inter" font-size="64" font-weight="700" fill="${INK}">See your live ads,</text>`);
    parts.push(`<text x="84" y="446" font-family="Inter" font-size="64" font-weight="700" fill="${INK}">scored.</text>`);
    parts.push(`<text x="84" y="500" font-family="Inter" font-size="28" font-weight="400" fill="${MUTE}">Free. No card.</text>`);
  }

  // Their creative, framed on the right (only when we have one to show).
  if (creative) {
    parts.push(`<rect x="700" y="146" width="420" height="396" rx="20" fill="${PANEL}" stroke="${LINE}" stroke-width="1.5"/>`);
    parts.push(`<image x="716" y="162" width="388" height="364" clip-path="url(#ccrea)" preserveAspectRatio="xMidYMid meet" xlink:href="${creative}" href="${creative}"/>`);
  }

  parts.push(`</svg>`);
  return parts.join('');
}

export async function boardOgImageHandler(req, res) {
  const slug = (req.query && (req.query.slug || req.query.s)) || '';
  try {
    const domain = slugToDomain(slug);
    const company = domain ? nameFromDomain(domain) : 'Your ads';

    let stats = null, worstImg = null, worstPlat = null;
    if (_redis && domain) {
      const domKey = domain.replace(/[^a-z0-9.]/g, '');
      // Primary: the compact snapshot the board writes on every render (has scored metrics + the worst
      // creative). Fallback: the raw pull cache (works only if it happens to hold scored ads).
      try {
        const rawOg = await _redis.get('ads:ogstats:' + domKey);
        const og = rawOg ? (typeof rawOg === 'string' ? JSON.parse(rawOg) : rawOg) : null;
        if (og && typeof og.off === 'number') { // new-shape snapshot with the two board metrics
          stats = { count: og.count, avg: og.avg, off: og.off, crit: og.crit, offPct: og.offPct };
          worstImg = og.worstImg || null; worstPlat = og.worstPlat || null;
        }
      } catch (e) {}
      if (!stats) {
        try {
          const raw = await _redis.get('ads:pull:' + domKey);
          const pull = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
          if (pull && pull.ads) { stats = boardStats(pull.ads); const w = worstCreative(pull.ads); if (w) { worstImg = w.img; worstPlat = w.plat; } }
        } catch (e) { stats = null; }
      }
    }

    // Fetch the company logo and the spotlight creative in parallel; either can fail to null.
    const licdn = worstImg && /licdn|linkedin/i.test(String(worstImg));
    const [coLogo, creative] = await Promise.all([
      domain ? firstDataUri([
        'https://img.logo.dev/' + domain + '?token=' + LOGO_DEV_TOKEN + '&size=200&format=png&retina=true',
        'https://logo.clearbit.com/' + domain + '?size=200',
        'https://www.google.com/s2/favicons?sz=128&domain=' + domain,
      ], { 'user-agent': UA }) : Promise.resolve(null),
      worstImg ? fetchDataUri(worstImg, licdn ? { referer: 'https://www.linkedin.com/', 'user-agent': UA } : { 'user-agent': UA }) : Promise.resolve(null),
    ]);

    await ensureWasm();
    const svg = buildSvg({ company, domain, stats, adLogo: adLogoDataUri(), coLogo, creative });
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: 1200 },
      font: { fontBuffers: loadFonts(), defaultFontFamily: 'Inter', loadSystemFonts: false },
    }).render().asPng();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(Buffer.from(png));
  } catch (e) {
    console.error('[og-image] render failed:', e && (e.stack || e.message || String(e)));
    if (req.query && req.query.debug) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(500).send('og-image error: ' + (e && (e.stack || e.message || String(e))));
      return;
    }
    res.setHeader('Location', 'https://www.adroast.in/og-hero.png?v=1');
    res.status(302).end();
  }
}
