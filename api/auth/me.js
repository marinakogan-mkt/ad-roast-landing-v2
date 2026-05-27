/**
 * GET /api/auth/me
 *
 * Reads the session cookie and returns the current authenticated session.
 *   - 200 { email, mode, partnerId, clientId } when logged in
 *   - 401 { error } when no session or session expired
 *
 * The portal app calls this on mount to decide whether to show the gate
 * or the authenticated portal view.
 */

import { Redis } from '@upstash/redis';
import { readSessionCookie, publicSession } from './_allowlist.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionToken = readSessionCookie(req);
  if (!sessionToken) {
    return res.status(401).json({ error: 'Not signed in' });
  }

  let session = null;
  try {
    const raw = await redis.get(`auth:session:${sessionToken}`);
    if (raw) session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('[auth/me] redis get error:', e.message);
    return res.status(500).json({ error: 'Session lookup failed' });
  }

  if (!session) {
    return res.status(401).json({ error: 'Session expired' });
  }

  /* Don't include passwords or anything sensitive — only what the portal needs to route. */
  return res.status(200).json({
    success: true,
    session: publicSession(session)
  });
}
