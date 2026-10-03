// Video ad -> one storyboard image, so the roast can actually SEE the video.
//
// A LinkedIn video ad only ever exposes a still poster in the board pull, never the clip, so the
// roast used to score video ads on their post copy alone and mark the creative "not analyzed".
// This module turns a video ad into a single 6-frame storyboard JPEG (hook -> demo -> end card)
// that Claude reads in one cheap image: the burned-in captions mirror the voice-over, so one
// storyboard gives us the written text, the spoken script, AND the visual execution at once.
//
// Everything runs server-side (nothing on anyone's laptop) and is cached per ad id for 30 days,
// so the download + ffmpeg pass happens ONCE per video ever; later roasts reuse the storyboard
// for free. Any failure returns null and the caller falls back to the copy-only "not analyzed"
// path, so a video we can't fetch is never scored on a guess.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Resolve the bundled ffmpeg binary lazily so a missing/broken ffmpeg-static can NEVER crash the
// roast function at import time; it just disables video analysis (callers fall back gracefully).
async function ffmpegBin() {
  try {
    const mod = await import('ffmpeg-static');
    const p = mod && (mod.default || mod);
    return (typeof p === 'string' && p) ? p : null;
  } catch (e) { return null; }
}

// The ad-library detail page is public but server-blocked (Cloudflare), so read it through Jina
// Reader, exactly like the board pull does. The rendered HTML carries the <video data-sources=...>.
async function jinaHtml(url) {
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

// Pull the progressive MP4 URL out of the <video data-sources="[{type,src}]"> blob, preferring the
// SMALLEST rendition (360p) so the download and decode stay tiny. The attribute is HTML-escaped.
function extractMp4Url(html) {
  const m = html.match(/data-sources="([^"]+)"/);
  if (!m) return null;
  const s = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&#39;/g, "'");
  const urls = s.match(/https:\/\/dms\.licdn\.com\/[^"\\ ,}]+/g) || [];
  if (!urls.length) return null;
  return urls.find(u => /360p/.test(u))
    || urls.find(u => /480p/.test(u))
    || urls.find(u => /640p/.test(u))
    || urls.find(u => /progressive/.test(u))
    || urls[0];
}

function adIdFromUrl(detailUrl) {
  const m = String(detailUrl || '').match(/\/detail\/(\d+)/);
  return m ? m[1] : null;
}

// ffmpeg writes the Duration to stderr even when asked for no output; read it so we can space the
// 6 frames evenly across the whole clip instead of grabbing the first few seconds.
function probeDurationSec(bin, vpath) {
  try {
    const r = spawnSync(bin, ['-i', vpath], { encoding: 'utf8', timeout: 15000 });
    const err = (r.stderr || '') + (r.stdout || '');
    const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  } catch (e) { return 0; }
}

/**
 * Build a 6-frame storyboard for a video ad. Returns { b64, mime } or null.
 * Cached in Redis by ad id (vframes:v1:<id>): the storyboard for 30 days, a miss for 12 hours so a
 * temporarily-unreachable video retries soon instead of being judged blind forever.
 */
export async function videoStoryboard({ detailUrl, adId, redis }) {
  const id = adId || adIdFromUrl(detailUrl);
  const key = 'vframes:v1:' + (id || String(detailUrl || '').replace(/\W+/g, '').slice(-32));
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        const v = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return v && v.b64 ? { b64: v.b64, mime: v.mime || 'image/jpeg' } : null; // {none:true} => known miss
      }
    } catch (e) {}
  }
  const miss = async () => { if (redis) { try { await redis.set(key, JSON.stringify({ none: true }), { ex: 60 * 60 * 12 }); } catch (e) {} } return null; };

  let dir = null;
  try {
    if (!detailUrl && !id) return await miss();
    const ff = await ffmpegBin();
    if (!ff) return await miss(); // no ffmpeg available: disable video analysis, never crash
    const target = detailUrl || ('https://www.linkedin.com/ad-library/detail/' + id);
    const html = await jinaHtml(target);
    if (!html) return await miss();
    const mp4 = extractMp4Url(html);
    if (!mp4) return await miss();

    // Download the smallest rendition (needs a LinkedIn Referer or the CDN 403s "InvalidToken").
    const vc = new AbortController();
    const vt = setTimeout(() => vc.abort(), 20000);
    let r;
    try { r = await fetch(mp4, { headers: { 'User-Agent': UA, Referer: 'https://www.linkedin.com/' }, signal: vc.signal }); }
    finally { clearTimeout(vt); }
    if (!r || !r.ok) return await miss();
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 25_000_000) return await miss();

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
    const vpath = path.join(dir, 'v.mp4');
    const spath = path.join(dir, 's.jpg');
    fs.writeFileSync(vpath, buf);

    const dur = probeDurationSec(ff, vpath) || 48; // default spacing if the probe fails
    const span = Math.max(dur, 3);                 // guard tiny clips
    // 6 frames evenly across the clip, scaled to 480px wide (captions stay readable), tiled 2x3.
    const vf = `fps=6/${span.toFixed(2)},scale=480:-2,tile=2x3`;
    const out = spawnSync(ff, ['-y', '-i', vpath, '-vf', vf, '-frames:v', '1', '-q:v', '5', spath], { timeout: 25000 });
    if (out.status !== 0 || !fs.existsSync(spath)) return await miss();
    const jpg = fs.readFileSync(spath);
    if (!jpg.length || jpg.length > 2_000_000) return await miss();

    const b64 = jpg.toString('base64');
    if (redis) { try { await redis.set(key, JSON.stringify({ b64, mime: 'image/jpeg' }), { ex: 60 * 60 * 24 * 30 }); } catch (e) {} }
    return { b64, mime: 'image/jpeg' };
  } catch (e) {
    return await miss();
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  }
}
