// Per-company link-preview IMAGE for /b/<slug> (og:image), rendered on demand as a 1200x630 PNG.
// A card shared on LinkedIn shows the image referenced by og:image; _board-og.js points that tag at
// /api/icp?ogimg=1&slug=<slug>, which lands here. We render a branded card for THAT company: their
// own logo, their real creatives in feed-style post cards, a red ring around them and an URGENT /
// FIX NOW tag, over the bone ground of the design Marina approved (AdRoast Link Cards Final, 9 nov
// 2026). The headline lives in the image now, so it has to be wrapped here (see textW/wrapText).
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
// The ads we spotlight in the preview: the worst-scoring ones with a usable creative (the same
// "start here" ads the board recommends), never the same creative twice.
function worstCreatives(ads, n) {
  const withImg = (ads || []).filter(a => typeof a.score === 'number' && a.img && /^https?:\/\//.test(String(a.img)) && !isJunk(a));
  const sorted = withImg.slice().sort((a, b) => a.score - b.score);
  const out = [];
  for (const a of sorted) { if (out.some(o => o.img === a.img)) continue; out.push(a); if (out.length >= (n || 1)) break; }
  return out;
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

// ── Palette and type. Straight from the design Marina signed off on (AdRoast Link Cards Final,
// 9 nov 2026): bone ground, ink text, the last words of the headline in red, the ad in a white post
// card, a hand-drawn-looking red ring around it and an URGENT / FIX NOW tag pinned to the corner.
const BONE = '#f3f2f0';
const INK = '#0b1220';
const RED = '#e5383b';
const MUTE = '#59626f';
const BLUE = '#0a66c2';
const LINE = '#e2e8f0';
const SLOT = '#f3f2f0';
const CW = 1200, CH = 630;
const CX = 64, COL = 436; // left column: x and usable width (500 wide, 64 of padding)

// Inter Bold advance widths in 1/1000 em for ASCII 32..126, measured off the very TTF this function
// ships. resvg lays out text itself but cannot WRAP, so we break the headline here, and breaking it
// by character count puts the line breaks in the wrong place. Anything outside the table (accents)
// falls back to a mid-width value, which only ever costs a slightly early break.
const IW = [232,325,392,650,655,859,674,209,409,409,565,680,303,469,298,390,688,489,630,659,678,645,660,595,661,660,298,303,680,680,680,563,1031,748,661,752,727,613,585,761,746,281,570,690,567,915,735,782,648,783,656,655,668,729,748,1036,714,724,667,409,390,409,488,477,497,580,635,587,635,598,386,633,624,272,272,582,272,912,622,614,632,632,409,562,389,622,586,850,574,586,572,409,374,409,680];
function textW(s, size, ls) {
  const t = String(s == null ? '' : s);
  let u = 0;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i) - 32; u += (c >= 0 && c < IW.length) ? IW[c] : 600; }
  return u / 1000 * size + (ls || 0) * Math.max(0, t.length - 1);
}
function wrapText(text, size, maxw, ls) {
  const out = []; let cur = '';
  for (const wd of String(text || '').split(/\s+/).filter(Boolean)) {
    const t = cur ? cur + ' ' + wd : wd;
    if (!cur || textW(t, size, ls) <= maxw) cur = t; else { out.push(cur); cur = wd; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}
// Where the first baseline falls inside a line box, the way a browser places it (Inter's hhea metrics
// are 0.969 ascent / 0.241 descent), so an SVG built from CSS line-heights lands on the same pixels.
const baseOff = (size, lh) => 0.5 * (lh - 1.21 * size) + 0.969 * size;
const n1 = (v) => Math.round(v * 10) / 10;

// Simple deterministic brand color for the monogram fallback when no logo image resolves.
function monoColor(seed) {
  let h = 0; const str = String(seed || 'a');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hues = ['#0a66c2', '#2563eb', '#7c3aed', '#0891b2', '#db2777', '#ea580c', '#059669'];
  return hues[h % hues.length];
}
// corp.kaltura.com reads as a subdomain in an ad's "Sponsored ·" line; the ad itself says kaltura.com.
function shortDomain(d) { return String(d || '').replace(/^(www|corp|go|get|try|info|ads|hq|app)\./, ''); }

// A creative inside its slot. `ratio` forces the Google ad block (wide and short) anchored to the top,
// which is how the sitelinks underneath the ad stay out of the frame.
function imgFit(id, bx, by, bw, bh, src, ratio) {
  if (!src) return { defs: '', body: `<rect x="${bx}" y="${n1(by)}" width="${bw}" height="${n1(bh)}" rx="8" fill="${SLOT}"/>` };
  if (ratio) {
    let iw = bw, ih = bw / ratio;
    if (ih > bh) { ih = bh; iw = bh * ratio; }
    const ix = n1(bx + (bw - iw) / 2), iy = n1(by + (bh - ih) / 2);
    return {
      defs: `<clipPath id="${id}"><rect x="${ix}" y="${iy}" width="${n1(iw)}" height="${n1(ih)}" rx="8"/></clipPath>`,
      body: `<image x="${ix}" y="${iy}" width="${n1(iw)}" height="${n1(ih)}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice" xlink:href="${src}" href="${src}"/>`,
    };
  }
  return {
    defs: `<clipPath id="${id}"><rect x="${bx}" y="${n1(by)}" width="${bw}" height="${n1(bh)}" rx="8"/></clipPath>`,
    body: `<image x="${bx}" y="${n1(by)}" width="${bw}" height="${n1(bh)}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid meet" xlink:href="${src}" href="${src}"/>`,
  };
}
// The advertiser's logo in the post row: contained in its slot, monogram when nothing resolves.
function logoSlot(id, x, y, s, src, circle, company, domain) {
  const r = circle ? Math.round(s / 2) : 8;
  if (!src) {
    const c = monoColor(domain || company);
    return { defs: '', body: `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}" fill="${c}"/>`
      + `<text x="${x + s / 2}" y="${y + Math.round(s * 0.68)}" font-family="Inter" font-size="${Math.round(s * 0.5)}" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(String(company || '?').charAt(0).toUpperCase())}</text>` };
  }
  return {
    defs: `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}"/></clipPath>`,
    body: `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r}" fill="${SLOT}"/>`
      + `<image x="${x + 3}" y="${y + 3}" width="${s - 6}" height="${s - 6}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid meet" xlink:href="${src}" href="${src}"/>`,
  };
}
// One ad as it looks in the feed: the post row (advertiser logo, name, Promoted) over the creative.
function adCard(o) {
  const { id, x, y, w, h, rot, pad, lg, circle, name, sub, nameSize, subSize, logo, img, ratio, domain, row } = o;
  const gap = pad <= 22 ? 12 : 14;
  const hasRow = row !== false;
  const iy = y + pad + (hasRow ? lg + gap : 0);
  const ih = h - pad * 2 - (hasRow ? lg + gap : 0);
  const A = imgFit(id + 'a', x + pad, iy, w - 2 * pad, ih, img, ratio);
  let defs = A.defs, inner = A.body;
  if (hasRow) {
    const L = logoSlot(id + 'l', x + pad, y + pad, lg, logo, circle, name, domain);
    const tx = x + pad + lg + gap + 2;
    defs += L.defs;
    inner = L.body + inner
      + `<text x="${tx}" y="${n1(y + pad + lg * 0.42)}" font-family="Inter" font-size="${nameSize}" font-weight="700" fill="${INK}">${esc(name)}</text>`
      + `<text x="${tx}" y="${n1(y + pad + lg * 0.42 + subSize + 10)}" font-family="Inter" font-size="${subSize}" font-weight="400" fill="${MUTE}">${esc(sub)}</text>`;
  }
  const body = `<g transform="rotate(${rot} ${n1(x + w / 2)} ${n1(y + h / 2)})" filter="url(#sh)">`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="#ffffff"/>` + inner + `</g>`;
  return { defs, body };
}
// The red ring. CSS draws it as a 7px border on a border-radius:50% box, so it is an ellipse whose
// radii are the box minus the stroke, turned -4deg about its own centre.
function ringEl(x, y, w, h, rot = -4, sw = 7) {
  const cx = n1(x + w / 2), cy = n1(y + h / 2);
  return `<ellipse cx="${cx}" cy="${cy}" rx="${n1((w - sw) / 2)}" ry="${n1((h - sw) / 2)}" fill="none" stroke="${RED}" stroke-width="${sw}" transform="rotate(${rot} ${cx} ${cy})"/>`;
}
function tagEl(text, size, top = 40, right = 36, rot = 6) {
  const t = String(text).toUpperCase(), ls = 0.04 * size;
  const w = textW(t, size, ls) + 52, h = 32 + 1.21 * size;
  const x = CW - right - w, cx = x + w / 2, cy = top + h / 2;
  return `<g transform="rotate(${rot} ${n1(cx)} ${n1(cy)})" filter="url(#sh2)">`
    + `<rect x="${n1(x)}" y="${top}" width="${n1(w)}" height="${n1(h)}" rx="12" fill="${RED}"/>`
    + `<text x="${n1(cx + ls / 2)}" y="${n1(cy + 0.355 * size)}" font-family="Inter" font-size="${size}" font-weight="800" letter-spacing="${n1(ls)}" fill="#ffffff" text-anchor="middle">${esc(t)}</text></g>`;
}
function buttonEl(text, size, x, y) {
  const w = textW(text, size, 0) + 56, h = 36 + 1.21 * size;
  return { h, body: `<rect x="${x}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="12" fill="${BLUE}"/>`
    + `<text x="${n1(x + w / 2)}" y="${n1(y + h / 2 + 0.355 * size)}" font-family="Inter" font-size="${size}" font-weight="800" fill="#ffffff" text-anchor="middle">${esc(text)}</text>` };
}
// The headline: wrapped here, with the closing words in red the way the design has them.
function headlineEl(x, y, size, lh, lead, tail) {
  const ls = -0.04 * size;
  const all = (lead + ' ' + (tail || '')).trim();
  const lines = wrapText(all, size, COL, ls);
  const total = all.split(/\s+/).length;
  const nTail = tail ? String(tail).split(/\s+/).length : 0;
  const off = baseOff(size, lh);
  const out = []; let i = 0;
  lines.forEach((ln, k) => {
    out.push(`<text x="${x}" y="${n1(y + off + k * lh)}" font-family="Inter" font-size="${size}" font-weight="700" letter-spacing="${n1(ls)}" fill="${INK}">`);
    ln.split(/\s+/).forEach((wd, j) => {
      const c = (i >= total - nTail) ? RED : INK; i++;
      out.push(`<tspan fill="${c}">${j ? ' ' : ''}${esc(wd)}</tspan>`);
    });
    out.push(`</text>`);
  });
  return { body: out.join(''), h: lines.length * lh, lines: lines.length };
}
const SHADOWS = `<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="24" stdDeviation="20" flood-color="#0b1220" flood-opacity="0.18"/></filter>`
  + `<filter id="sh2" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="9" flood-color="${RED}" flood-opacity="0.40"/></filter>`;
// Google Ads mark, as the design draws it: two round-capped strokes and the green dot.
const gAdsMark = (x, y, s) => `<g transform="translate(${x},${n1(y)}) scale(${n1(s / 100)})">`
  + `<line x1="50" y1="16" x2="78" y2="70" stroke="#4285F4" stroke-width="24" stroke-linecap="round"/>`
  + `<line x1="50" y1="16" x2="28" y2="58" stroke="#FBBC04" stroke-width="24" stroke-linecap="round"/>`
  + `<circle cx="22" cy="70" r="13" fill="#34A853"/></g>`;
const GOOGLE_RATIO = 2.2553; // the Google ad block without its sitelinks

// ── The board-wide card (/b/<domain>): their logo, the headline, the button, their two worst ads.
function buildSvg(opts) {
  const { company, domain, stats, adLogo, coLogo, creatives } = opts;
  const size = 72, lh = 0.98 * size;
  const imgs = (creatives || []).filter(Boolean);
  const btnTxt = (stats && stats.off) ? `See the ${stats.off} ads →` : 'See your live ads →';
  const btn = buttonEl(btnTxt, 36, CX, 0);
  const hl0 = wrapText('Ads that need you today', size, COL, -0.04 * size).length * lh;
  const y0 = (CH - (110 + 36 + hl0 + 36 + btn.h + 36 + 50)) / 2;
  const hl = headlineEl(CX, y0 + 110 + 36, size, lh, 'Ads that need you', 'today');
  const by = y0 + 110 + 36 + hl.h + 36;
  const two = imgs.length > 1;
  const c1 = two ? adCard({ id: 'b1', x: 560, y: 110, w: 400, h: 390, rot: -5, pad: 22, lg: 50, name: company, sub: 'Promoted', nameSize: 24, subSize: 18, logo: coLogo, img: imgs[1], domain }) : null;
  const c2 = adCard({ id: 'b2', x: two ? 760 : 680, y: two ? 90 : 120, w: 400, h: 390, rot: 4, pad: 22, lg: 50, name: company, sub: 'Promoted', nameSize: 24, subSize: 18, logo: coLogo, img: imgs[0], domain });
  const p = [];
  p.push(`<svg width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`);
  p.push(`<defs>${SHADOWS}${c1 ? c1.defs : ''}${c2.defs}`);
  if (coLogo) p.push(`<clipPath id="lk"><rect x="${CX}" y="${n1(y0)}" width="170" height="110"/></clipPath>`);
  p.push(`</defs>`);
  p.push(`<rect width="${CW}" height="${CH}" fill="${BONE}"/>`);
  if (coLogo) p.push(`<image x="${CX}" y="${n1(y0)}" width="170" height="110" clip-path="url(#lk)" preserveAspectRatio="xMinYMid meet" xlink:href="${coLogo}" href="${coLogo}"/>`);
  else {
    const c = monoColor(domain || company);
    p.push(`<rect x="${CX}" y="${n1(y0)}" width="110" height="110" rx="20" fill="${c}"/>`);
    p.push(`<text x="${CX + 55}" y="${n1(y0 + 78)}" font-family="Inter" font-size="58" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(String(company || '?').charAt(0).toUpperCase())}</text>`);
  }
  p.push(hl.body);
  p.push(buttonEl(btnTxt, 36, CX, by).body);
  if (adLogo) p.push(`<image x="${CX}" y="${n1(by + btn.h + 36)}" width="50" height="50" xlink:href="${adLogo}" href="${adLogo}"/>`);
  if (c1) p.push(c1.body);
  p.push(c2.body);
  p.push(two ? ringEl(500, 28, 700, 572) : ringEl(620, 60, 520, 500));
  p.push(tagEl('Urgent', 40));
  p.push(`</svg>`);
  return p.join('');
}

// ── The platform card (/b/<domain>/linkedin, /google, /meta). Marina, 5 nov 2026: the second outreach
// message ("the two linkedin ads I'd fix first are in here") was showing the very same card as the
// board link above it. This one names the platform and shows that platform's worst ad, ringed.
const PLAT = {
  linkedin: { label: 'LinkedIn', band: '#0a66c2' },
  google: { label: 'Google', band: '#1a73e8' },
  meta: { label: 'Meta', band: '#0866ff' },
};
// Google's ad screenshot already carries the advertiser and the URL inside it, so repeating them in a
// post row prints the name twice. LinkedIn creatives carry neither, so there the row stays.
const GOOGLE_POST_ROW = false;
function buildPlatSvg(opts) {
  const { company, domain, plat, ps, adLogo, coLogo, creatives } = opts;
  const P = PLAT[plat] || PLAT.linkedin;
  const img = (creatives || []).filter(Boolean)[0] || null;
  const isG = plat === 'google';
  const size = 72, lh = 0.98 * size;
  const lead = `Your ${P.label} ad is`, tail = 'leaking clicks';
  const nl = wrapText(lead + ' ' + tail, size, COL, -0.04 * size).length;
  const y0 = (CH - (150 + 48 + nl * lh)) / 2;
  const hl = headlineEl(CX, y0 + 150 + 48, size, lh, lead, tail);
  const card = adCard({
    id: 'p1', x: 600, y: 110, w: 540, h: 400, rot: 0, pad: 26, lg: 56, circle: isG,
    name: company, sub: isG ? `Sponsored · ${shortDomain(domain)}` : 'Promoted',
    nameSize: 26, subSize: 20, logo: coLogo, img, ratio: isG ? GOOGLE_RATIO : null,
    domain, row: isG ? GOOGLE_POST_ROW : true,
  });
  const p = [];
  p.push(`<svg width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`);
  p.push(`<defs>${SHADOWS}${card.defs}</defs>`);
  p.push(`<rect width="${CW}" height="${CH}" fill="${BONE}"/>`);
  if (isG) p.push(gAdsMark(CX, y0, 150));
  else if (adLogo) p.push(`<image x="${CX}" y="${n1(y0)}" width="150" height="150" xlink:href="${adLogo}" href="${adLogo}"/>`);
  p.push(hl.body);
  p.push(card.body);
  p.push(ringEl(580, 90, 580, 440));
  p.push(tagEl('Fix now', 38));
  p.push(`</svg>`);
  return p.join('');
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

    let stats = null, worstImg = null, worstPlat = null, worstTwo = [];
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
          // The board card shows their two worst ads side by side; worst2 is written next to
          // worstImg by icp.js. Older snapshots have only worstImg, and then one card is drawn.
          if (Array.isArray(og.worst2)) worstTwo = og.worst2.filter(t => t && t.img).slice(0, 2);
        }
        if (plat && og && og.byPlat && og.byPlat[plat]) platStats = og.byPlat[plat];
      } catch (e) {}
      if (!stats) {
        try {
          const raw = await _redis.get('ads:pull:' + domKey);
          const pull = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
          if (pull && pull.ads) {
            stats = boardStats(pull.ads);
            const ws = worstCreatives(pull.ads, 2);
            if (ws.length) { worstImg = ws[0].img; worstPlat = ws[0].plat; worstTwo = ws.map(w => ({ score: w.score, img: w.img, plat: w.plat || null })); }
          }
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

    // Fetch the company logo and their two worst creatives in parallel; any of them can fail to null
    // and the card simply shows one ad, or an empty slot, instead of breaking.
    const hdrFor = (u) => (/licdn|linkedin/i.test(String(u)) ? { referer: 'https://www.linkedin.com/', 'user-agent': UA } : { 'user-agent': UA });
    const imgUrls = (worstTwo.length ? worstTwo.map(t => t.img) : (worstImg ? [worstImg] : []));
    const [coLogo, ...creatives] = await Promise.all([
      // Same resolver the board uses: the logo the company declares on its own site first
      // (apple-touch-icon / schema.org / favicon), Logo.dev + Google favicon as the safety net.
      domain ? logoCandidates(domain).then((urls) => firstDataUri(urls, { 'user-agent': UA })) : Promise.resolve(null),
      ...imgUrls.map(u => fetchDataUri(u, hdrFor(u))),
    ]);

    await ensureWasm();
    const svg = buildSvg({ company, domain, stats, adLogo: adLogoDataUri(), coLogo, creatives });
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
