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
import { logoCandidates } from './_logo.js';

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

// A waste-gravity chip label for the shareable card (this is the outreach hook, so it uses the
// punchier spend framing the founder designed for it; the in-product board stays measured).
function wasteChip(offPct) {
  return offPct >= 70 ? { t: 'SEVERE WASTE', c: RED }
    : offPct >= 30 ? { t: 'HIGH WASTE', c: RED }
    : offPct >= 10 ? { t: 'LEAKING BUDGET', c: AMBER }
    : offPct > 0 ? { t: 'MINOR WASTE', c: AMBER }
    : { t: 'ON TARGET', c: GREEN };
}
// One metric panel: big value on top, label under it, soft tinted by severity.
function statPanel(x, y, w, h, color, value, label) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${color}14" stroke="${color}2e" stroke-width="1.5"/>`
    + `<text x="${x + 28}" y="${y + 92}" font-family="Inter" font-size="78" font-weight="800" fill="${color}">${esc(value)}</text>`
    + `<text x="${x + 30}" y="${y + 132}" font-family="Inter" font-size="27" font-weight="700" fill="${INK}">${esc(label)}</text>`;
}

function buildSvg(opts) {
  const { company, domain, stats, adLogo, coLogo, creative } = opts;
  const parts = [];
  parts.push(`<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`);
  parts.push(`<defs>`);
  parts.push(`<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3f8fe"/><stop offset="1" stop-color="#e7eff9"/></linearGradient>`);
  parts.push(`<linearGradient id="spec" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#dc2626"/><stop offset="0.35" stop-color="#d97706"/><stop offset="0.62" stop-color="#64748b"/><stop offset="1" stop-color="#0a66c2"/></linearGradient>`);
  parts.push(`<clipPath id="clogo"><rect x="68" y="128" width="64" height="64" rx="14"/></clipPath>`);
  parts.push(`<clipPath id="ccrea"><rect x="800" y="64" width="372" height="300" rx="16"/></clipPath>`);
  parts.push(`</defs>`);

  // Soft branded ground + a white "report card" inset (with a faint drop shadow) so it feels designed.
  parts.push(`<rect width="1200" height="630" fill="url(#bg)"/>`);
  parts.push(`<rect x="28" y="32" width="1144" height="574" rx="28" fill="#0f1b2d" opacity="0.06"/>`);
  parts.push(`<rect x="28" y="24" width="1144" height="574" rx="28" fill="#ffffff" stroke="#e6ebf2" stroke-width="1.5"/>`);

  // Brand row: AdRoast logo + domain wordmark.
  if (adLogo) parts.push(`<image x="68" y="58" width="38" height="38" xlink:href="${adLogo}" href="${adLogo}"/>`);
  parts.push(`<text x="${adLogo ? 116 : 68}" y="88" font-family="Inter" font-size="31" font-weight="700" fill="${BLUE}">adroast.in</text>`);

  // Company row: their logo (or monogram) + name.
  if (coLogo) {
    parts.push(`<rect x="68" y="128" width="64" height="64" rx="14" fill="#ffffff" stroke="${LINE}" stroke-width="1.5"/>`);
    parts.push(`<image x="68" y="128" width="64" height="64" clip-path="url(#clogo)" preserveAspectRatio="xMidYMid meet" xlink:href="${coLogo}" href="${coLogo}"/>`);
  } else {
    const c = monoColor(domain || company);
    parts.push(`<rect x="68" y="128" width="64" height="64" rx="14" fill="${c}"/>`);
    parts.push(`<text x="100" y="172" font-family="Inter" font-size="34" font-weight="700" fill="#ffffff" text-anchor="middle">${esc((company || '?').charAt(0).toUpperCase())}</text>`);
  }
  const n = (company || '').length;
  const nameSize = n <= 10 ? 64 : n <= 16 ? 56 : n <= 24 ? 44 : 34;
  const nameY = 160 + Math.round(nameSize * 0.35); // vertically centered against the 64px logo
  parts.push(`<text x="148" y="${nameY}" font-family="Inter" font-size="${nameSize}" font-weight="700" fill="${INK}">${esc(company)}</text>`);

  if (stats) {
    // Marina 2026-09-14: "las letras son muy pequenias". LinkedIn suele pintar el
    // preview a ~240px de ancho, o sea 1/5: todo lo que no llegue a ~100px en este
    // lienzo no se lee. Por eso hay UN heroe grande en vez de dos paneles chicos, y
    // la chip de gravedad es la unica etiqueta. Nada de "spend": no lo medimos.
    const wc = sevOffTarget(stats.offPct);
    const chLabel = wc.t.toUpperCase();
    const chW = Math.round(chLabel.length * 13) + 58;
    parts.push(`<rect x="68" y="222" width="${chW}" height="46" rx="23" fill="${wc.c}16"/>`);
    parts.push(`<circle cx="96" cy="245" r="6" fill="${wc.c}"/>`);
    parts.push(`<text x="112" y="254" font-family="Inter" font-size="25" font-weight="700" letter-spacing="1" fill="${wc.c}">${esc(chLabel)}</text>`);

    // El heroe: cuantos de sus ads le hablan al comprador equivocado.
    const hero = `${stats.off} of ${stats.count}`;
    parts.push(`<text x="68" y="404" font-family="Inter" font-size="132" font-weight="800" letter-spacing="-4" fill="${wc.c}">${esc(hero)}</text>`);
    parts.push(`<text x="68" y="462" font-family="Inter" font-size="46" font-weight="700" fill="${INK}">live ads miss the buyer</text>`);

    // Espectro: rojo (comprador equivocado) a azul (en el blanco), con el promedio.
    const sx = 68, sw = 668, sy = 524;
    parts.push(`<rect x="${sx}" y="${sy}" width="${sw}" height="14" rx="7" fill="url(#spec)"/>`);
    const mx = sx + Math.round(Math.max(0, Math.min(10, stats.avg)) / 10 * sw);
    parts.push(`<circle cx="${mx}" cy="${sy + 7}" r="13" fill="${scoreColor(stats.avg)}" stroke="#ffffff" stroke-width="4"/>`);
    parts.push(`<text x="${sx}" y="${sy + 46}" font-family="Inter" font-size="21" font-weight="700" letter-spacing="1" fill="${RED}">WRONG BUYER</text>`);
    parts.push(`<text x="${sx + sw}" y="${sy + 46}" font-family="Inter" font-size="21" font-weight="700" letter-spacing="1" fill="${BLUE}" text-anchor="end">ON TARGET</text>`);
  } else {
    parts.push(`<text x="68" y="330" font-family="Inter" font-size="60" font-weight="700" fill="${INK}">See your live ads,</text>`);
    parts.push(`<text x="68" y="400" font-family="Inter" font-size="60" font-weight="700" fill="${INK}">scored.</text>`);
    parts.push(`<text x="68" y="452" font-family="Inter" font-size="27" font-weight="400" fill="${MUTE}">Free. No card.</text>`);
  }

  // Right column: their creative in a frame, then a "Roast these ads" button.
  parts.push(`<rect x="800" y="64" width="372" height="300" rx="16" fill="${PANEL}" stroke="${LINE}" stroke-width="1.5"/>`);
  if (creative) {
    parts.push(`<image x="814" y="78" width="344" height="272" clip-path="url(#ccrea)" preserveAspectRatio="xMidYMid meet" xlink:href="${creative}" href="${creative}"/>`);
  } else {
    parts.push(`<text x="986" y="222" font-family="Inter" font-size="24" font-weight="400" fill="${MUTE}" text-anchor="middle">Live ad</text>`);
  }
  parts.push(`<rect x="800" y="388" width="372" height="66" rx="14" fill="${BLUE}"/>`);
  parts.push(`<text x="986" y="430" font-family="Inter" font-size="30" font-weight="700" fill="#ffffff" text-anchor="middle">Roast these ads →</text>`);

  parts.push(`</svg>`);
  return parts.join('');
}

// The platform card (/b/<domain>/linkedin, /google, /meta). Marina, 5 nov 2026: the second message
// ("the two linkedin ads I'd fix first are in here") showed the same card as the board link above it.
// This one has to look different and say what the link is: the platform's two worst ads, side by side,
// each with its score, under a band in the platform's color. Same readability rule as the board card
// (LinkedIn paints it ~240px wide), so few, big elements.
const PLAT = {
  linkedin: { label: 'LinkedIn', band: '#0a66c2' },
  google: { label: 'Google', band: '#1a73e8' },
  meta: { label: 'Meta', band: '#0866ff' },
};
function buildPlatSvg(opts) {
  const { company, domain, plat, ps, adLogo, coLogo, creatives } = opts;
  const P = PLAT[plat];
  const top = (ps && ps.top) || [];
  const n = Math.max(1, Math.min(2, top.length || 2));
  const parts = [];
  parts.push(`<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`);
  // card frames: two 236x300 side by side, or one 492x300
  const fy = 140, fh = 300;
  const frames = n === 2 ? [{ x: 640, w: 236 }, { x: 896, w: 236 }] : [{ x: 640, w: 492 }];
  parts.push(`<defs>`);
  parts.push(`<clipPath id="clogo"><rect x="68" y="136" width="64" height="64" rx="14"/></clipPath>`);
  frames.forEach((f, i) => parts.push(`<clipPath id="cf${i}"><rect x="${f.x}" y="${fy}" width="${f.w}" height="${fh}" rx="16"/></clipPath>`));
  parts.push(`</defs>`);
  parts.push(`<rect width="1200" height="630" fill="#ffffff"/>`);

  // Platform band.
  parts.push(`<rect width="1200" height="96" fill="${P.band}"/>`);
  parts.push(`<text x="68" y="62" font-family="Inter" font-size="36" font-weight="800" letter-spacing="1" fill="#ffffff">${esc(P.label.toUpperCase())} ADS</text>`);
  if (adLogo) {
    parts.push(`<rect x="962" y="26" width="44" height="44" rx="10" fill="#ffffff"/>`);
    parts.push(`<image x="965" y="29" width="38" height="38" xlink:href="${adLogo}" href="${adLogo}"/>`);
  }
  parts.push(`<text x="1132" y="60" font-family="Inter" font-size="29" font-weight="700" fill="#ffffff" text-anchor="end">adroast.in</text>`);

  // Company row.
  if (coLogo) {
    parts.push(`<rect x="68" y="136" width="64" height="64" rx="14" fill="#ffffff" stroke="${LINE}" stroke-width="1.5"/>`);
    parts.push(`<image x="68" y="136" width="64" height="64" clip-path="url(#clogo)" preserveAspectRatio="xMidYMid meet" xlink:href="${coLogo}" href="${coLogo}"/>`);
  } else {
    const c = monoColor(domain || company);
    parts.push(`<rect x="68" y="136" width="64" height="64" rx="14" fill="${c}"/>`);
    parts.push(`<text x="100" y="180" font-family="Inter" font-size="34" font-weight="700" fill="#ffffff" text-anchor="middle">${esc((company || '?').charAt(0).toUpperCase())}</text>`);
  }
  const cl = (company || '').length;
  const nameSize = cl <= 12 ? 46 : cl <= 20 ? 38 : 30;
  parts.push(`<text x="148" y="${168 + Math.round(nameSize * 0.35)}" font-family="Inter" font-size="${nameSize}" font-weight="700" fill="${INK}">${esc(company)}</text>`);

  // The claim: which ads, and that they go first.
  const l1 = n === 2 ? 'The 2 ads' : 'The ad';
  parts.push(`<text x="68" y="318" font-family="Inter" font-size="86" font-weight="800" letter-spacing="-3" fill="${RED}">${esc(l1)}</text>`);
  parts.push(`<text x="68" y="408" font-family="Inter" font-size="86" font-weight="800" letter-spacing="-3" fill="${INK}">to fix first</text>`);
  if (ps && ps.count) {
    const sub = `${ps.off} of ${ps.count} live ${P.label} ads miss the buyer`;
    const subSize = sub.length <= 36 ? 30 : 26;
    parts.push(`<text x="70" y="470" font-family="Inter" font-size="${subSize}" font-weight="600" fill="${MUTE}">${esc(sub)}</text>`);
  }

  // The ads themselves, each with its score under it.
  frames.forEach((f, i) => {
    const ad = top[i] || null;
    parts.push(`<rect x="${f.x}" y="${fy}" width="${f.w}" height="${fh}" rx="16" fill="${PANEL}" stroke="${LINE}" stroke-width="1.5"/>`);
    const img = creatives && creatives[i];
    if (img) {
      parts.push(`<image x="${f.x + 8}" y="${fy + 8}" width="${f.w - 16}" height="${fh - 16}" clip-path="url(#cf${i})" preserveAspectRatio="xMidYMid meet" xlink:href="${img}" href="${img}"/>`);
    } else if (ad && ad.head) {
      // No creative to show (Google text ads): the headline itself, wrapped in the frame.
      const words = String(ad.head).split(/\s+/); const lines = []; let cur = '';
      const max = Math.floor((f.w - 40) / 15);
      for (const w of words) { if ((cur + ' ' + w).trim().length > max) { if (cur) lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); if (lines.length === 5) break; }
      if (cur && lines.length < 5) lines.push(cur);
      lines.forEach((ln, j) => parts.push(`<text x="${f.x + 20}" y="${fy + 52 + j * 36}" font-family="Inter" font-size="26" font-weight="700" fill="${INK}">${esc(ln)}</text>`));
    } else {
      parts.push(`<text x="${f.x + f.w / 2}" y="${fy + fh / 2 + 8}" font-family="Inter" font-size="24" font-weight="400" fill="${MUTE}" text-anchor="middle">Live ad</text>`);
    }
    if (ad && typeof ad.score === 'number') {
      const c = scoreColor(ad.score);
      const cx = f.x + f.w / 2;
      parts.push(`<rect x="${cx - 78}" y="${fy + fh + 22}" width="156" height="70" rx="35" fill="${c}"/>`);
      parts.push(`<text x="${cx}" y="${fy + fh + 71}" font-family="Inter" font-size="40" font-weight="800" fill="#ffffff" text-anchor="middle">${esc(ad.score + '/10')}</text>`);
    }
  });

  // Footer CTA in the platform color.
  parts.push(`<text x="68" y="566" font-family="Inter" font-size="30" font-weight="700" fill="${P.band}">See why, and the fix for each →</text>`);
  parts.push(`</svg>`);
  return parts.join('');
}

export async function boardOgImageHandler(req, res) {
  const slug = (req.query && (req.query.slug || req.query.s)) || '';
  try {
    const domain = slugToDomain(slug);
    let company = domain ? nameFromDomain(domain) : 'Your ads';
    // The real name, same sources and order as the og:title in _board-og.js. The domain label alone
    // put "Corp" on corp.kaltura.com's card while the title right next to it said Kaltura.
    if (_redis && domain) {
      try {
        const dk = domain.replace(/[^a-z0-9.]/g, '');
        const [nm, pr] = await Promise.all([_redis.get('geo:name:' + dk), _redis.get('geo:icp:' + dk)]);
        const icpRec = pr ? (typeof pr === 'string' ? JSON.parse(pr) : pr) : null;
        const realName = icpRec && typeof icpRec.company === 'string' ? icpRec.company.trim() : '';
        if (nm && typeof nm === 'string' && nm.trim() && nm.trim().length <= 60) company = nm.trim();
        else if (realName && realName.length <= 60) company = realName;
      } catch (e) {}
    }
    // Platform view: from ?p= (what _board-og writes) or the slug's second segment.
    const pq = String((req.query && req.query.p) || '').toLowerCase();
    const ps2 = (String(slug).toLowerCase().match(/^[^/?#]+\/(linkedin|google|meta)\b/) || [])[1] || '';
    const plat = PLAT[pq] ? pq : (PLAT[ps2] ? ps2 : '');
    let platStats = null;

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
        if (plat && og && og.byPlat && og.byPlat[plat]) platStats = og.byPlat[plat];
      } catch (e) {}
      if (!stats) {
        try {
          const raw = await _redis.get('ads:pull:' + domKey);
          const pull = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
          if (pull && pull.ads) { stats = boardStats(pull.ads); const w = worstCreative(pull.ads); if (w) { worstImg = w.img; worstPlat = w.plat; } }
        } catch (e) { stats = null; }
      }
    }

    if (plat) {
      // Older snapshots have no byPlat: fall back to the clean per-ad list (scores, no images), plus the
      // board-wide worst creative when it happens to be from this platform.
      if (!platStats && _redis && domain) {
        try {
          const raw = await _redis.get('ads:geo:' + domain.replace(/[^a-z0-9.]/g, ''));
          const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
          const pl = (Array.isArray(list) ? list : []).filter(a => typeof a.score === 'number' && String(a.plat || '').toLowerCase() === plat);
          if (pl.length) {
            const sorted = pl.slice().sort((a, b) => a.score - b.score);
            const t = sorted.slice(0, 2).map(a => ({ score: a.score, head: a.head || '', img: null }));
            if (t[0] && worstImg && String(worstPlat || '').toLowerCase() === plat) t[0].img = worstImg;
            const off = pl.filter(a => a.score <= 6).length;
            platStats = { count: pl.length, off, top: t };
          }
        } catch (e) {}
      }
      const tops = (platStats && platStats.top) || [];
      const hdr = (u) => (/licdn|linkedin/i.test(String(u)) ? { referer: 'https://www.linkedin.com/', 'user-agent': UA } : { 'user-agent': UA });
      const [coLogoP, ...creatives] = await Promise.all([
        domain ? logoCandidates(domain).then((urls) => firstDataUri(urls, { 'user-agent': UA })) : Promise.resolve(null),
        ...tops.map(t => (t && t.img ? fetchDataUri(t.img, hdr(t.img)) : Promise.resolve(null))),
      ]);
      await ensureWasm();
      const svgP = buildPlatSvg({ company, domain, plat, ps: platStats, adLogo: adLogoDataUri(), coLogo: coLogoP, creatives });
      const pngP = new Resvg(svgP, {
        fitTo: { mode: 'width', value: 1200 },
        font: { fontBuffers: loadFonts(), defaultFontFamily: 'Inter', loadSystemFonts: false },
      }).render().asPng();
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
      res.status(200).send(Buffer.from(pngP));
      return;
    }

    // Fetch the company logo and the spotlight creative in parallel; either can fail to null.
    const licdn = worstImg && /licdn|linkedin/i.test(String(worstImg));
    const [coLogo, creative] = await Promise.all([
      // Same resolver the board uses: the logo the company declares on its own site first
      // (apple-touch-icon / schema.org / favicon), Logo.dev + Google favicon as the safety net.
      domain ? logoCandidates(domain).then((urls) => firstDataUri(urls, { 'user-agent': UA })) : Promise.resolve(null),
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
