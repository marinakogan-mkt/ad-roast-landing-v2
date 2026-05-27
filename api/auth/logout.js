/**
 * POST /api/auth/logout
 *
 * Clears the session cookie and removes the session from Redis.
 * Always returns 200 — logout is idempotent.
 */

import { Redis } from '@upstash/redis';
import { readSessionCookie, clearSessionCookie } from './_allowlist.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionToken = readSessionCookie(req);
  if (sessionToken) {
    try {
      await redis.del(`auth:session:${sessionToken}`);
    } catch (e) {
      console.error('[auth/logout] redis del error:', e.message);
      /* Continue — we still want to clear the cookie. */
    }
  }

  res.setHeader('Set-Cookie', clearSessionCookie());
  return res.status(200).json({ success: true });
}
