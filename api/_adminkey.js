// Admin auth WITHOUT a browser session: a personal API key (ak_...) whose owner is a portal master.
// Same mechanism as /api/roast, the MCP server, roast-view's isAdminKey and _usage.originOf
// (roast:apikey:<key> -> email), shared here so the Batch pre-score actions in icp.js do not carry
// a fourth copy. Header only (Authorization: Bearer or x-api-key), never ?key= in the URL: a key in
// a query string ends up in request logs and browser history.
// Underscore prefix => NOT its own Vercel function (the Hobby 12-function cap is full).
import { PORTAL_ROLES } from './auth/_allowlist.js';

const ADMIN_EMAILS = new Set(((PORTAL_ROLES.find(r => r.mode === 'master') || {}).emails || []).map(e => String(e).toLowerCase()));

export async function isAdminKey(req, redis) {
  try {
    if (!redis) return false;
    const h = (req && req.headers) || {};
    const m = /^Bearer\s+(ak_[A-Za-z0-9_]+)/i.exec(h.authorization || '');
    const key = String((m && m[1]) || h['x-api-key'] || '');
    if (!/^ak_[A-Za-z0-9_]+$/.test(key)) return false;
    const em = await redis.get(`roast:apikey:${key}`);
    return !!(em && ADMIN_EMAILS.has(String(em).toLowerCase()));
  } catch (e) {
    return false;
  }
}
