// Per-company link-preview IMAGE for /b/<slug> (og:image), rendered on demand as a 1200x630 PNG.
// A card shared on LinkedIn shows the image referenced by og:image; _board-og.js points that tag at
// /api/icp?ogimg=1&slug=<slug>, which lands here. We render a branded card named for the company with
// its live board stats, so the preview is about THAT company, not the generic AdRoast hero.
//
// WHY satori + resvg-wasm (not @vercel/og): @vercel/og 1.x is ESM-only and its Node build throws
// "Dynamic require of fs" (harfbuzz) in a "type":"module" project, and its edge build would need a
// separate function file = a 12th Vercel Function over the Hobby cap. satori (vdom -> SVG) and
// @resvg/resvg-wasm (SVG -> PNG) are both ESM-clean and run on the Node runtime, so this stays folded
// into icp.js. Imported dynamically from icp.js so none of it loads on the normal ICP/scoring path.
// The font + wasm ship in api/_assets and are referenced via new URL(import.meta.url) so Vercel's
// bundler traces them into the function. Any failure redirects to the static hero, so the card can
// never break.
import fs from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';
import satori from 'satori';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

let _redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
} catch (e) { _redis = null; }

// Locate a bundled asset. We read via process.cwd() (like _board-og.js reads index.html) rather than
// new URL(import.meta.url): Vercel bundles the function to CommonJS, where import.meta is a syntax
// error. vercel.json's functions.includeFiles ships api/_assets/** into the function so it's on disk.
function assetPath(name) {
  for (const base of [path.join(process.cwd(), 'api', '_assets'), '/var/task/api/_assets']) {
    try { const p = path.join(base, name); if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return path.join(process.cwd(), 'api', '_assets', name); // let readFileSync throw a clear ENOENT
}

// Read the bundled assets once per warm process.
let _fonts = null;
function loadFonts() {
  if (_fonts) return _fonts;
  const reg = fs.readFileSync(assetPath('inter-regular.woff'));
  const bold = fs.readFileSync(assetPath('inter-bold.woff'));
  _fonts = [
    { name: 'Inter', data: reg, weight: 400, style: 'normal' },
    { name: 'Inter', data: bold, weight: 700, style: 'normal' },
  ];
  return _fonts;
}

// initWasm must run exactly once per process; cache the promise so concurrent requests share it.
let _wasmReady = null;
function ensureWasm() {
  if (!_wasmReady) {
    const bytes = fs.readFileSync(assetPath('resvg.wasm'));
    _wasmReady = initWasm(bytes).catch((e) => {
      // "Already initialized" is fine (another path won the race); anything else re-throws on use.
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

// Minimal hyperscript so we build the satori vdom without JSX (functions ship as plain .js here).
const h = (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children }, key: null });

const INK = '#141426';
const INK_2 = '#1f1f3a';
const ACCENT = '#3b8ff0';
const WHITE = '#ffffff';
const MUTE = '#9a9ac2';

function chip(label, value, tone) {
  return h('div', { style: {
    display: 'flex', flexDirection: 'column', gap: '4px',
    background: INK_2, borderRadius: '16px', padding: '20px 28px',
    border: '1px solid ' + (tone === 'warn' ? 'rgba(255,138,120,0.35)' : 'rgba(59,143,240,0.30)'),
  } },
    h('div', { style: { fontSize: '44px', fontWeight: 700, color: tone === 'warn' ? '#ff8a78' : WHITE, display: 'flex' } }, value),
    h('div', { style: { fontSize: '22px', color: MUTE, display: 'flex' } }, label)
  );
}

function card(company, stats) {
  const bottom = stats
    ? h('div', { style: { display: 'flex', gap: '20px' } },
        chip('live ads', String(stats.count)),
        chip('avg fit', stats.avg + '/10'),
        chip('to fix', String(stats.toFix), 'warn')
      )
    : h('div', { style: { display: 'flex', fontSize: '26px', color: MUTE } },
        'Every live ad, scored against the buyer. Free, no card.');

  return h('div', { style: {
    width: '1200px', height: '630px', display: 'flex', flexDirection: 'row',
    background: INK, fontFamily: 'Inter',
  } },
    h('div', { style: { width: '14px', height: '100%', background: ACCENT, display: 'flex' } }),
    h('div', { style: {
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      padding: '68px 76px', flex: 1,
    } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', fontSize: '24px', letterSpacing: '2px', color: MUTE, fontWeight: 700 } },
        h('div', { style: { display: 'flex', color: ACCENT } }, 'ADROAST'),
        h('div', { style: { display: 'flex' } }, '·  LIVE AD TEARDOWN')
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { style: { display: 'flex', fontSize: '96px', fontWeight: 700, color: ACCENT, lineHeight: 1 } }, company),
        h('div', { style: { display: 'flex', fontSize: '52px', fontWeight: 700, color: WHITE, lineHeight: 1.15 } }, 'Where their ads lose the buyer')
      ),
      bottom
    )
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
    const svg = await satori(card(company, stats), { width: 1200, height: 630, fonts: loadFonts() });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();

    res.setHeader('Content-Type', 'image/png');
    // Cache on the CDN and in the crawler; stats refresh within the hour.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(Buffer.from(png));
  } catch (e) {
    console.error('[og-image] render failed:', e && (e.stack || e.message || String(e)));
    if (req.query && req.query.debug) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(500).send('og-image error: ' + (e && (e.stack || e.message || String(e))));
      return;
    }
    // Never break the card: fall back to the static branded hero.
    res.setHeader('Location', 'https://www.adroast.in/og-hero.png?v=1');
    res.status(302).end();
  }
}
