/**
 * GET /api/auth/verify?token=<magicToken>
 *
 * Exchanges a one-time magic-link token for a 7-day session cookie.
 *   - Looks up the token in Upstash.
 *   - If valid and unexpired:
 *       - Generates a new session token
 *       - Stores session in Redis with 7-day TTL
 *       - Deletes the magic token (one-time use)
 *       - Sets the httpOnly session cookie
 *       - Redirects to /#portal (the portal app reads /api/auth/me on mount)
 *   - If invalid/expired: redirects to /?auth=expired (the gate shows an error)
 */

import { Redis } from '@upstash/redis';
import { buildSessionCookie, SESSION_TTL_SECONDS } from './_allowlist.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

function randomToken(bytes = 32) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < bytes; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function htmlRedirect(url, message) {
  /* Some browsers strip cookies on 302 redirect, so we serve an HTML meta-refresh
     that also has the Set-Cookie header attached. The body just shows a brief
     "Signing you in…" before the redirect fires. */
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0; url=${url}">
<title>AdRoast — Signing you in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #f5f5f7; color: #1a1a1a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px; text-align: center; max-width: 380px; }
  .spinner { width: 28px; height: 28px; border: 3px solid #e5e7eb; border-top-color: #0a66c2; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { margin: 4px 0; font-size: 14px; line-height: 1.5; color: #6b7280; }
  a { color: #0a66c2; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <p><strong style="color: #1a1a1a;">${message}</strong></p>
  <p>Redirecting to your portal…</p>
  <p style="margin-top: 12px; font-size: 12px;"><a href="${url}">Click here if you're not redirected automatically</a></p>
</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const token = (req.query?.token || '').trim();
  if (!token) {
    return res.redirect(302, '/?auth=missing');
  }

  let magicData = null;
  try {
    const raw = await redis.get(`auth:magic:${token}`);
    if (raw) magicData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('[auth/verify] redis get error:', e.message);
    return res.redirect(302, '/?auth=error');
  }

  if (!magicData) {
    /* Token invalid or already used or expired */
    return res.redirect(302, '/?auth=expired#portal');
  }

  /* Generate session token, store session, delete magic token (one-time use) */
  const sessionToken = randomToken(32);
  try {
    await redis.set(
      `auth:session:${sessionToken}`,
      JSON.stringify({
        email: magicData.email,
        roleId: magicData.roleId,
        mode: magicData.mode,
        partnerId: magicData.partnerId,
        clientId: magicData.clientId,
        createdAt: Date.now()
      }),
      { ex: SESSION_TTL_SECONDS }
    );
    await redis.del(`auth:magic:${token}`);
    /* Log the successful sign-in for the audit trail */
    await redis.lpush(
      `auth:log:${magicData.email}`,
      JSON.stringify({
        at: new Date().toISOString(),
        roleId: magicData.roleId,
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
        ua: req.headers['user-agent'] || 'unknown'
      })
    );
    /* Trim the log to the last 50 entries per email so it doesn't grow unbounded. */
    await redis.ltrim(`auth:log:${magicData.email}`, 0, 49);
  } catch (e) {
    console.error('[auth/verify] redis set/del error:', e.message);
    return res.redirect(302, '/?auth=error');
  }

  /* Set the session cookie and redirect to the portal */
  res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.status(200).send(htmlRedirect('/#portal', 'Welcome to the portal.'));
}
