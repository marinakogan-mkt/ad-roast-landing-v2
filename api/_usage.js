// Spend by ORIGIN: who asked for each Anthropic call (a person on the board, Marina, a cron of the
// outreach engine, an agency through the API or the MCP, the Apify actor, a report migration).
// logClaudeUsage already says WHICH feature called the model (board-score, roast, icp...), but not
// who triggered it, and that is what decides whether a call can go through the Batch API at half
// price (nobody waiting) or must stay real-time. Vercel Hobby keeps runtime logs ~1 h, so the
// counts go to Redis: one hash per UTC day, `usage:day:YYYY-MM-DD`, field
// `<site>|<origin>|<model>|<metric>`, kept 120 days. Read with /api/roast-view?action=usage.
//
// The origin is resolved lazily, on the first Claude call of a request, so requests that never
// call the model cost no extra Redis read. Never throws and never delays the response.
// Underscore prefix => NOT its own Vercel function (the Hobby 12-function cap is full).
import { AsyncLocalStorage } from 'node:async_hooks';
import { Redis } from '@upstash/redis';
import { readSessionCookie, PORTAL_ROLES } from './auth/_allowlist.js';

const als = new AsyncLocalStorage();
let _redis = null;
function redis() {
  if (!_redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
  return _redis;
}
const ADMIN = new Set(((PORTAL_ROLES.find(r => r.mode === 'master') || {}).emails || []).map(e => String(e).toLowerCase()));
const NOT_HUMAN_UA = /bot|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|embedly|preview/i;
const tag = s => String(s || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);

async function originOf(req) {
  try {
    const h = (req && req.headers) || {};
    if (h['x-roast-migrate']) return 'migrar';
    if (String(h['x-adroast-as'] || '').toLowerCase() === 'apify') return 'apify';
    const via = tag(h['x-adroast-via']);
    const m = /^Bearer\s+(ak_[A-Za-z0-9_]+)/i.exec(h.authorization || '');
    const key = String((m && m[1]) || h['x-api-key'] || '');
    if (/^ak_[A-Za-z0-9_]+$/.test(key)) {
      const r = redis();
      const em = r ? await r.get(`roast:apikey:${key}`) : null;
      const admin = !!(em && ADMIN.has(String(em).toLowerCase()));
      if (via === 'mcp') return admin ? 'mcp-marina' : 'mcp-cliente';
      // Marina's own key = her scripts (outreach engine, jobsearch, GEO warming). They name
      // themselves in x-adroast-src (the script file), so discovery and venta read apart.
      if (admin) { const src = tag(h['x-adroast-src']); return src ? 'motor:' + src : 'motor'; }
      return 'api-cliente';
    }
    if (via === 'mcp') return 'mcp';
    const tok = readSessionCookie(req);
    if (tok && redis()) {
      const raw = await redis().get('auth:session:' + tok);
      const s = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (s && s.email) return ADMIN.has(String(s.email).toLowerCase()) ? 'web-marina' : 'web-cuenta';
    }
    if (NOT_HUMAN_UA.test(String(h['user-agent'] || ''))) return 'web-bot';
    return 'web';
  } catch (e) {
    return 'desconocido';
  }
}

/* Wrap a Vercel handler so every Claude call inside it knows the request it belongs to. */
export function withUsage(handler) {
  return function (req, res) {
    return als.run({ req, origin: null }, () => handler(req, res));
  };
}

function keepAlive(p) {
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  } catch (e) { /* best effort */ }
}

/* Count one Anthropic response. `u` is data.usage. */
export function recordUsage(site, model, u) {
  if (!u) return;
  const st = als.getStore();
  const p = (async () => {
    const r = redis();
    if (!r) return;
    if (st && !st.origin) st.origin = originOf(st.req);
    const origin = st ? await st.origin : 'sin-contexto';
    const day = new Date().toISOString().slice(0, 10);
    const k = 'usage:day:' + day;
    const base = `${tag(site)}|${origin}|${tag(model)}|`;
    const cw = u.cache_creation_input_tokens || 0;
    const cw1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
    const pl = r.pipeline();
    pl.hincrby(k, base + 'calls', 1);
    if (u.input_tokens) pl.hincrby(k, base + 'in', u.input_tokens);
    if (cw - cw1h > 0) pl.hincrby(k, base + 'cw5m', cw - cw1h);
    if (cw1h) pl.hincrby(k, base + 'cw1h', cw1h);
    if (u.cache_read_input_tokens) pl.hincrby(k, base + 'cr', u.cache_read_input_tokens);
    if (u.output_tokens) pl.hincrby(k, base + 'out', u.output_tokens);
    pl.expire(k, 60 * 60 * 24 * 120);
    await pl.exec();
  })().catch(() => {});
  keepAlive(p);
  return p;
}
