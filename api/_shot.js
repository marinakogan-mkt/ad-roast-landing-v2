/* Landing-page screenshot with fallbacks (24 nov 2026).

   ScreenshotOne's free plan is 100 renders a month. When it answers "quota exhausted" (or fails for
   any other reason that is not a bot wall) the shot is taken by the next provider instead of leaving
   the report without its landing:

     1. ScreenshotOne      (SCREENSHOTONE_ACCESS_KEY)
     2. Cloudflare Browser Rendering /snapshot  (CF_ACCOUNT_ID + CF_BR_TOKEN; free plan: 10 browser
        minutes a day, one request every 10 s; 429 past that)
     3. Microlink          (no key; free plan ~5 renders a day)
     4. thum.io            (only when the caller allows it; no cookie blocking and no wall check, so it
                            is served as a redirect and never cached or pinned)

   Nothing here runs on a schedule: it is only called when a person roasts or opens a report.
   Every render goes out from the provider's servers, never from Marina's machine or accounts.

   Bot walls: a page that answers with a "verify you are human" challenge has no honest screenshot.
   Any provider that sees one stops the chain (walled: true) so the caller can show the link card.

   Each provider used is logged ("[shot] provider=...") and counted per day in Redis under
   shot:prov:<YYYY-MM-DD>:<provider> (kept 40 days), so the recheck can see how often the
   fallbacks carry the load. */

export const WALL_PHRASES = ['Performing security verification', 'Verify you are human', 'Verifying you are human', 'Just a moment...', 'Checking your browser', 'Enable JavaScript and cookies to continue', 'Attention Required'];

// Hides the common consent managers so the hero, not the cookie wall, is what gets captured.
const COOKIE_CSS = [
  '#onetrust-consent-sdk', '#onetrust-banner-sdk', '.onetrust-pc-dark-filter',
  '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay', '#cookiebanner',
  '#usercentrics-root', '#usercentrics-cmp-ui', '.cky-consent-container', '.cky-overlay',
  '#hs-eu-cookie-confirmation', '#truste-consent-track', '#consent_blackbar', '.truste_overlay',
  '#didomi-host', '.didomi-popup-backdrop', '#qc-cmp2-container', '.qc-cmp2-container',
  '#iubenda-cs-banner', '#termly-code-snippet-support', '[id^="sp_message_container"]',
  '.osano-cm-window', '.osano-cm-dialog', '#cmplz-cookiebanner-container', '.cmplz-cookiebanner',
  '#cookie-law-info-bar', '.cc-window', '.cc-banner', '#gdpr-cookie-message', '.cookie-consent',
  '#cookie-consent', '#cookieConsent', '.cookie-banner', '#cookie-banner', '.cookies-banner',
  '#axeptio_overlay', '#tarteaucitronRoot', '#klaro', '.klaro', '#moove_gdpr_cookie_info_bar',
  '#intercom-container', '.intercom-lightweight-app', '#hubspot-messages-iframe-container',
  '#drift-widget-container', '#drift-frame-controller', '.drift-frame-controller',
].join(',') + '{display:none!important;visibility:hidden!important}' +
  'html,body{overflow:auto!important}';

const hasWall = (text) => {
  const t = String(text || '');
  return WALL_PHRASES.some(p => t.includes(p));
};

const withTimeout = async (url, opts, ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), Math.max(1000, ms));
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
};

async function viaScreenshotOne(target, ms) {
  const key = process.env.SCREENSHOTONE_ACCESS_KEY;
  if (!key) return { skip: true };
  const so = new URL('https://api.screenshotone.com/take');
  so.searchParams.set('access_key', key);
  so.searchParams.set('url', target);
  so.searchParams.set('format', 'jpg');
  so.searchParams.set('viewport_width', '1280');
  so.searchParams.set('viewport_height', '900');
  so.searchParams.set('image_quality', '82');
  so.searchParams.set('block_cookie_banners', 'true');
  so.searchParams.set('block_ads', 'true');
  so.searchParams.set('block_chats', 'true');
  so.searchParams.set('timeout', String(Math.max(5, Math.min(30, Math.floor(ms / 1000) - 1))));
  // Bot-wall pages render fine as images, so ScreenshotOne reports success; refuse them by their text.
  WALL_PHRASES.forEach(m => so.searchParams.append('fail_if_content_contains', m));
  const up = await withTimeout(so.toString(), {}, ms);
  const ct = up.headers.get('content-type') || '';
  if (up.ok && /^image\//i.test(ct)) return { buf: Buffer.from(await up.arrayBuffer()), ct };
  let body = '';
  try { body = JSON.stringify(await up.json()); } catch (e) {}
  if (/content_contains_specified_string/.test(body)) return { walled: true };
  return { error: 'screenshotone ' + up.status + ' ' + body.slice(0, 160) };
}

async function viaCloudflare(target, ms) {
  const acct = process.env.CF_ACCOUNT_ID, tok = process.env.CF_BR_TOKEN;
  if (!acct || !tok) return { skip: true };
  const navMs = Math.max(5000, Math.min(30000, ms - 3000));
  const up = await withTimeout(`https://api.cloudflare.com/client/v4/accounts/${acct}/browser-rendering/snapshot`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: target,
      viewport: { width: 1280, height: 900 },
      gotoOptions: { waitUntil: 'networkidle2', timeout: navMs },
      addStyleTag: [{ content: COOKIE_CSS }],
      rejectResourceTypes: ['media'],
      screenshotOptions: { type: 'jpeg', quality: 82 },
    }),
  }, ms);
  let j = null;
  try { j = await up.json(); } catch (e) {}
  if (!up.ok || !j || !j.success || !j.result || !j.result.screenshot) {
    return { error: 'cloudflare ' + up.status + ' ' + JSON.stringify((j && j.errors) || '').slice(0, 160) };
  }
  if (hasWall(j.result.content)) return { walled: true };
  return { buf: Buffer.from(j.result.screenshot, 'base64'), ct: 'image/jpeg' };
}

async function viaMicrolink(target, ms) {
  const u = new URL('https://api.microlink.io/');
  u.searchParams.set('url', target);
  u.searchParams.set('screenshot', 'true');
  u.searchParams.set('meta', 'true'); // the title is how a challenge page is recognised
  u.searchParams.set('adblock', 'true');
  u.searchParams.set('viewport.width', '1280');
  u.searchParams.set('viewport.height', '900');
  u.searchParams.set('viewport.deviceScaleFactor', '1');
  u.searchParams.set('screenshot.type', 'jpeg');
  u.searchParams.set('styles', COOKIE_CSS);
  const up = await withTimeout(u.toString(), { headers: { 'User-Agent': 'AdRoast/1.0 (+https://adroast.in)' } }, ms);
  let j = null;
  try { j = await up.json(); } catch (e) {}
  if (!up.ok || !j || j.status !== 'success') return { error: 'microlink ' + up.status + ' ' + ((j && (j.code || j.message)) || '') };
  const d = j.data || {};
  if (hasWall(d.title) || hasWall(d.description)) return { walled: true };
  const shotUrl = d.screenshot && d.screenshot.url;
  if (!shotUrl) return { error: 'microlink no screenshot' };
  const img = await withTimeout(shotUrl, {}, 8000);
  const ct = img.headers.get('content-type') || 'image/jpeg';
  if (!img.ok || !/^image\//i.test(ct)) return { error: 'microlink image ' + img.status };
  return { buf: Buffer.from(await img.arrayBuffer()), ct };
}

async function count(redis, provider, target, ms) {
  console.log(`[shot] provider=${provider} ms=${ms} url=${target}`);
  if (!redis) return;
  try {
    const k = 'shot:prov:' + new Date().toISOString().slice(0, 10) + ':' + provider;
    await redis.incr(k);
    await redis.expire(k, 60 * 60 * 24 * 40);
  } catch (e) {}
}

/* Returns one of:
     { buf, ct, provider }              an image, safe to cache and pin
     { redirect, provider: 'thumio' }   last resort, serve as a redirect, do not cache or pin
     { walled: true, provider }         the site answers with a bot wall
     { failed: true, errors }           nothing worked; do not cache the miss
   deadlineMs is the total time the caller can spend. */
export async function renderShot(target, { deadlineMs = 45000, allowThumio = true, redis = null } = {}) {
  const t0 = Date.now();
  const left = () => deadlineMs - (Date.now() - t0);
  const errors = [];
  const chain = [['screenshotone', viaScreenshotOne, 30000], ['cloudflare', viaCloudflare, 30000], ['microlink', viaMicrolink, 20000]];
  for (const [name, fn, cap] of chain) {
    const ms = Math.min(cap, left() - 1500);
    if (ms < 4000) { errors.push(name + ' no time'); break; }
    let r;
    try { r = await fn(target, ms); } catch (e) { r = { error: name + ' ' + (e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error') }; }
    if (r.skip) continue;
    if (r.walled) { await count(redis, name + '-walled', target, Date.now() - t0); return { walled: true, provider: name }; }
    if (r.buf && r.buf.length) { await count(redis, name, target, Date.now() - t0); return { buf: r.buf, ct: r.ct || 'image/jpeg', provider: name }; }
    errors.push(r.error || name + ' empty');
  }
  if (allowThumio) {
    await count(redis, 'thumio', target, Date.now() - t0);
    return { redirect: 'https://image.thum.io/get/width/1000/crop/1200/' + target, provider: 'thumio', errors };
  }
  await count(redis, 'none', target, Date.now() - t0);
  console.log('[shot] all providers failed: ' + errors.join(' | '));
  return { failed: true, errors };
}
