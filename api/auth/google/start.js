/**
 * GET /api/auth/google/start
 *
 * Kicks off the "Continue with Google" flow.
 *   - Generates a CSRF state token, stores it in Upstash (10-min TTL)
 *   - Redirects the browser to Google's OAuth consent screen
 *
 * We request only the non-sensitive scopes (openid email profile) so the app
 * needs no Google verification. Google verifies the user controls the email;
 * we then check that email against the portal allowlist in the callback.
 */

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

function randomToken(n = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('Google sign-in is not configured.');
  }

  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/google/callback`;

  /* CSRF state — random token echoed back by Google and verified in the callback. */
  const state = randomToken(24);
  try {
    await redis.set(`auth:oauth_state:${state}`, '1', { ex: 600 }); // 10 min
  } catch (e) {
    console.error('[auth/google/start] redis error:', e.message);
    return res.status(500).send('Could not start Google sign-in. Please try again.');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account'
  });

  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
