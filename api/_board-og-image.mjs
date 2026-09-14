// Per-company link-preview IMAGE for /b/<slug> (og:image), rendered on demand as a 1200x630 PNG.
// A card shared on LinkedIn shows the image referenced by og:image; _board-og.js points that tag at
// /api/icp?ogimg=1&slug=<slug>, which lands here. We render a branded card named for the company with
// its live board stats, so the preview is about THAT company, not the generic AdRoast hero.
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
function boardStats(ads) {
  const scored = (ads || []).filter(a => typeof a.score === 'number');
  if (!scored.length) return null;
  const avg = scored.reduce((s, a) => s + a.score, 0) / scored.length;
  const toFix = scored.filter(a => a.score <= 4).length;
  return { count: scored.length, avg: Math.round(avg * 10) / 10, toFix };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const INK = '#141426';
const INK_2 = '#1f1f3a';
const ACCENT = '#3b8ff0';
const WHITE = '#ffffff';
const MUTE = '#9a9ac2';
const WARN = '#ff8a78';

// One stat chip: rounded panel with a big value and a small label. Fixed width, laid out left to right.
function chipSvg(x, y, w, value, label, tone) {
  const stroke = tone === 'warn' ? 'rgba(255,138,120,0.35)' : 'rgba(59,143,240,0.30)';
  const vColor = tone === 'warn' ? WARN : WHITE;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="104" rx="16" fill="${INK_2}" stroke="${stroke}" stroke-width="1"/>` +
    `<text x="${x + 28}" y="${y + 54}" font-family="Inter" font-size="44" font-weight="700" fill="${vColor}">${esc(value)}</text>` +
    `<text x="${x + 28}" y="${y + 86}" font-family="Inter" font-size="22" font-weight="400" fill="${MUTE}">${esc(label)}</text>`
  );
}

function buildSvg(company, stats) {
  // Company name font-size scales down for long names so it never runs off the card.
  const n = company.length;
  const size = n <= 9 ? 104 : n <= 13 ? 88 : n <= 18 ? 72 : n <= 26 ? 56 : 44;
  const compBaseline = 340;

  let bottom;
  if (stats) {
    const y = 470;
    // widen each chip enough for its value; simple fixed widths read fine for these ranges.
    const w1 = 210, w2 = 250, w3 = 190, gap = 20;
    bottom =
      chipSvg(76, y, w1, String(stats.count), 'live ads') +
      chipSvg(76 + w1 + gap, y, w2, stats.avg + '/10', 'avg fit') +
      chipSvg(76 + w1 + gap + w2 + gap, y, w3, String(stats.toFix), 'to fix', 'warn');
  } else {
    bottom = `<text x="76" y="512" font-family="Inter" font-size="26" font-weight="400" fill="${MUTE}">Every live ad, scored against the buyer. Free, no card.</text>`;
  }

  return (
    `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="1200" height="630" fill="${INK}"/>` +
    `<rect x="0" y="0" width="14" height="630" fill="${ACCENT}"/>` +
    // eyebrow
    `<text x="76" y="112" font-family="Inter" font-size="24" font-weight="700" letter-spacing="2" fill="${ACCENT}">ADROAST` +
    `<tspan fill="${MUTE}">   ·   LIVE AD TEARDOWN</tspan></text>` +
    // company name
    `<text x="76" y="${compBaseline}" font-family="Inter" font-size="${size}" font-weight="700" fill="${ACCENT}">${esc(company)}</text>` +
    // headline
    `<text x="76" y="418" font-family="Inter" font-size="52" font-weight="700" fill="${WHITE}">Where their ads lose the buyer</text>` +
    bottom +
    `</svg>`
  );
}

export async function boardOgImageHandler(req, res) {
  const slug = (req.query && (req.query.slug || req.query.s)) || '';
  try {
    const domain = slugToDomain(slug);
    const company = domain ? nameFromDomain(domain) : 'Your ads';

    let stats = null;
    if (_redis && domain) {
      try {
        const domKey = domain.replace(/[^a-z0-9.]/g, '');
        const raw = await _redis.get('ads:pull:' + domKey);
        const pull = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        stats = pull && pull.ads ? boardStats(pull.ads) : null;
      } catch (e) { stats = null; }
    }

    await ensureWasm();
    const svg = buildSvg(company, stats);
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
