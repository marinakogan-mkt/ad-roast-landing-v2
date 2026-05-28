/**
 * GET /api/auth/google/callback?code=...&state=...
 *
 * Google redirects here after the user consents.
 *   - Verifies the CSRF state token
 *   - Exchanges the auth code for tokens at Google's token endpoint
 *   - Decodes the id_token to get the verified email
 *   - Checks the email against the portal allowlist (email-only — Google already
 *     proved the user controls it, so no password needed)
 *   - On match: issues a 7-day session cookie + redirects to /#portal
 *   - On no match: redirects to /?auth=denied (gate shows "not authorized")
 */

import { Redis } from '@upstash/redis';
import { findRoleByEmail, buildSessionCookie, SESSION_TTL_SECONDS } from '../_allowlist.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

function randomToken(n = 32) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** Decode a JWT payload (no signature verification — token came directly from
    Google's token endpoint over server-to-server HTTPS, so it's trusted). */
function decodeJwtPayload(jwt) {
  try {
    const payload = jwt.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function htmlRedirect(url, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="refresh" content="0; url=${url}">
<title>AdRoast — Signing you in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f7;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;text-align:center;max-width:380px}.spinner{width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#0a66c2;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}@keyframes spin{to{transform:rotate(360deg)}}p{margin:4px 0;font-size:14px;line-height:1.5;color:#6b7280}a{color:#0a66c2;text-decoration:none}</style>
</head><body><div class="card"><div class="spinner"></div><p><strong style="color:#1a1a1a">${message}</strong></p><p>Redirecting…</p><p style="margin-top:12px;font-size:12px"><a href="${url}">Continue</a></p></div></body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const { code, state, error } = req.query || {};

  if (error) {
    /* User cancelled or denied consent */
    return res.redirect(302, '/?auth=cancelled#portal');
  }
  if (!code || !state) {
    return res.redirect(302, '/?auth=error#portal');
  }

  /* Verify CSRF state */
  try {
    const ok = await redis.get(`auth:oauth_state:${state}`);
    if (!ok) return res.redirect(302, '/?auth=error#portal');
    await redis.del(`auth:oauth_state:${state}`);
  } catch (e) {
    console.error('[auth/google/callback] state check error:', e.message);
    return res.redirect(302, '/?auth=error#portal');
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('Google sign-in is not configured.');
  }

  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/google/callback`;

  /* Exchange the code for tokens */
  let tokenData = null;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    });
    tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) {
      console.error('[auth/google/callback] token exchange error:', tokenData);
      return res.redirect(302, '/?auth=error#portal');
    }
  } catch (e) {
    console.error('[auth/google/callback] token fetch error:', e.message);
    return res.redirect(302, '/?auth=error#portal');
  }

  /* Decode id_token → verified email */
  const claims = decodeJwtPayload(tokenData.id_token || '');
  if (!claims || !claims.email) {
    return res.redirect(302, '/?auth=error#portal');
  }
  /* Sanity checks on the token claims */
  if (claims.aud !== clientId) {
    console.error('[auth/google/callback] aud mismatch');
    return res.redirect(302, '/?auth=error#portal');
  }
  if (claims.email_verified === false) {
    return res.redirect(302, '/?auth=denied#portal');
  }

  const email = String(claims.email).trim().toLowerCase();
  const role = findRoleByEmail(email);
  if (!role) {
    /* Authenticated with Google, but not on the portal allowlist */
    return res.redirect(302, '/?auth=denied#portal');
  }

  /* Issue session */
  const sessionToken = randomToken(32);
  try {
    await redis.set(
      `auth:session:${sessionToken}`,
      JSON.stringify({
        email: role.email,
        roleId: role.id,
        mode: role.mode,
        partnerId: role.partnerId || null,
        clientId: role.clientId || null,
        via: 'google',
        createdAt: Date.now()
      }),
      { ex: SESSION_TTL_SECONDS }
    );
    /* Audit log */
    await redis.lpush(`auth:log:${role.email}`, JSON.stringify({
      at: new Date().toISOString(),
      via: 'google',
      roleId: role.id,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
      ua: req.headers['user-agent'] || 'unknown'
    }));
    await redis.ltrim(`auth:log:${role.email}`, 0, 49);
  } catch (e) {
    console.error('[auth/google/callback] session store error:', e.message);
    return res.redirect(302, '/?auth=error#portal');
  }

  res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.status(200).send(htmlRedirect('/#portal', `Signed in as ${role.email}`));
}
