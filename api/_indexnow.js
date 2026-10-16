// IndexNow (Bing, Yandex, Seznam, Naver...): tell search engines the moment a NEW public page exists,
// instead of waiting for a sitemap crawl. Shared helper (underscore file = not a Vercel function, so
// it does not count against the 12-function cap). The key is public by design: it is served as a
// static file at https://www.adroast.in/<key>.txt and only proves we control the host.
//
// pingNewBoard(redis, domKey): call ONLY when a company was newly added to geo:companies (sadd === 1).
// Never throws, never blocks the response for long: dedupes per URL in Redis (SET NX, 30 days), and
// the POST runs under a 2.5s abort. Uses Vercel's waitUntil when available so it can finish after the
// response is sent; otherwise it is awaited with the same short cap.
export const INDEXNOW_KEY = '61ac7302ce7ef0f14bc2b3b3939394f6';
export const INDEXNOW_HOST = 'www.adroast.in';
export const INDEXNOW_KEY_LOCATION = 'https://' + INDEXNOW_HOST + '/' + INDEXNOW_KEY + '.txt';

export const submitIndexNow = async (urlList, timeoutMs = 2500) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: INDEXNOW_HOST, key: INDEXNOW_KEY, keyLocation: INDEXNOW_KEY_LOCATION, urlList }),
      signal: ctrl.signal,
    });
    return r.status;
  } catch (e) {
    return 0;
  } finally {
    clearTimeout(t);
  }
};

export const pingNewBoard = async (redis, domKey) => {
  try {
    const dom = String(domKey || '').trim();
    if (!dom) return;
    // Same URL shape as /sitemap-boards.xml.
    const url = 'https://' + INDEXNOW_HOST + '/b/' + encodeURIComponent(dom);
    if (redis) {
      const fresh = await redis.set('indexnow:sent:' + url, '1', { nx: true, ex: 60 * 60 * 24 * 30 });
      if (!fresh) return; // already pinged recently
    }
    const p = submitIndexNow([url]).catch(() => 0);
    let waitUntil = null;
    try {
      const ctx = globalThis[Symbol.for('@vercel/request-context')];
      const c = ctx && typeof ctx.get === 'function' ? ctx.get() : null;
      if (c && typeof c.waitUntil === 'function') waitUntil = c.waitUntil.bind(c);
    } catch (e) { waitUntil = null; }
    if (waitUntil) { waitUntil(p); return; }
    await p;
  } catch (e) { /* never break the board */ }
};
