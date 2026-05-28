/**
 * Consolidated portal auth endpoint. One serverless function, routed by ?action=
 * (Vercel Hobby caps the project at 12 functions, so we keep auth to 2 files:
 * this one + api/auth/google/callback.js, which must stay separate because its
 * path is the registered Google redirect URI).
 *
 * Routes:
 *   GET  /api/auth?action=me                       -> current session or 401
 *   POST /api/auth?action=logout                   -> clear session
 *   POST /api/auth?action=request-link             -> email+password -> magic link email
 *   GET  /api/auth?action=verify&token=<t>         -> magic token -> session cookie + redirect
 *   GET  /api/auth?action=google-start             -> redirect to Google OAuth consent
 */

import { Redis } from '@upstash/redis';
import {
  findRole,
  publicSession,
  buildSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  SESSION_TTL_SECONDS
} from './auth/_allowlist.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const EMAILJS_SERVICE_ID = 'service_ywioabe';
const EMAILJS_TEMPLATE_ID = 'template_gtqow85';
const EMAILJS_PUBLIC_KEY = '964Wa83HevoEa5KnS';

function randomToken(n = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function htmlRedirect(url, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="refresh" content="0; url=${url}">
<title>AdRoast — Signing you in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f7;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;text-align:center;max-width:380px}.spinner{width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#0a66c2;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}@keyframes spin{to{transform:rotate(360deg)}}p{margin:4px 0;font-size:14px;line-height:1.5;color:#6b7280}a{color:#0a66c2;text-decoration:none}</style>
</head><body><div class="card"><div class="spinner"></div><p><strong style="color:#1a1a1a">${message}</strong></p><p>Redirecting to your portal…</p><p style="margin-top:12px;font-size:12px"><a href="${url}">Continue</a></p></div></body></html>`;
}

/* ---- action handlers ------------------------------------------------------ */

async function handleMe(req, res) {
  const sessionToken = readSessionCookie(req);
  if (!sessionToken) return res.status(401).json({ error: 'Not signed in' });
  let session = null;
  try {
    const raw = await redis.get(`auth:session:${sessionToken}`);
    if (raw) session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return res.status(500).json({ error: 'Session lookup failed' });
  }
  if (!session) return res.status(401).json({ error: 'Session expired' });
  return res.status(200).json({ success: true, session: publicSession(session) });
}

async function handleLogout(req, res) {
  const sessionToken = readSessionCookie(req);
  if (sessionToken) {
    try { await redis.del(`auth:session:${sessionToken}`); } catch (e) {}
  }
  res.setHeader('Set-Cookie', clearSessionCookie());
  return res.status(200).json({ success: true });
}

async function handleRequestLink(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const email = (body.email || '').trim().toLowerCase();
  const password = (body.password || '').trim();
  if (!email || !password) return res.status(400).json({ error: 'Email and access code are both required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  /* Rate limiting: 5/email/hr, 20/IP/hr */
  try {
    const emailKey = `auth:ratelimit:email:${email}`;
    const ipKey = `auth:ratelimit:ip:${clientIp(req)}`;
    const ec = await redis.incr(emailKey); if (ec === 1) await redis.expire(emailKey, 3600);
    const ic = await redis.incr(ipKey); if (ic === 1) await redis.expire(ipKey, 3600);
    if (ec > 5 || ic > 20) return res.status(429).json({ error: 'Too many login attempts. Please try again in an hour.' });
  } catch (e) { /* fail open on rate-limit */ }

  const role = findRole(email, password);
  if (!role) {
    await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
    return res.status(200).json({ success: true, message: 'If that email is authorized, a sign-in link is on its way.' });
  }

  const token = randomToken(24);
  try {
    await redis.set(`auth:magic:${token}`, JSON.stringify({
      email: role.email, roleId: role.id, mode: role.mode,
      partnerId: role.partnerId || null, clientId: role.clientId || null, createdAt: Date.now()
    }), { ex: 15 * 60 });
  } catch (e) {
    return res.status(500).json({ error: 'Could not generate sign-in link. Please try again.' });
  }

  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const magicLink = `${proto}://${host}/api/auth?action=verify&token=${encodeURIComponent(token)}`;

  try {
    const message =
`You requested access to the AdRoast partner portal.

Click the link below to sign in. The link expires in 15 minutes and can only be used once.

${magicLink}

If you didn't request this, you can ignore this email — the link won't grant access without your password too.

— AdRoast`;
    /* EmailJS blocks non-browser (server-side) calls unless the Private Key is
       passed as accessToken. Include it when the env var is set. */
    const emailPayload = {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: { to_email: role.email, subject: 'Your AdRoast portal sign-in link', message }
    };
    if (process.env.EMAILJS_PRIVATE_KEY) {
      emailPayload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
    }
    const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload)
    });
    if (!emailRes.ok) {
      const text = await emailRes.text();
      console.error('[auth request-link] EmailJS error:', emailRes.status, text);
      return res.status(500).json({ error: 'Could not send sign-in email. Please try again or contact support.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not send sign-in email. Please try again.' });
  }

  return res.status(200).json({ success: true, message: 'Check your inbox for a sign-in link. It expires in 15 minutes.' });
}

async function handleVerify(req, res) {
  const token = (req.query?.token || '').trim();
  if (!token) return res.redirect(302, '/?auth=missing#portal');

  let magicData = null;
  try {
    const raw = await redis.get(`auth:magic:${token}`);
    if (raw) magicData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return res.redirect(302, '/?auth=error#portal');
  }
  if (!magicData) return res.redirect(302, '/?auth=expired#portal');

  const sessionToken = randomToken(32);
  try {
    await redis.set(`auth:session:${sessionToken}`, JSON.stringify({
      email: magicData.email, roleId: magicData.roleId, mode: magicData.mode,
      partnerId: magicData.partnerId, clientId: magicData.clientId, via: 'magic', createdAt: Date.now()
    }), { ex: SESSION_TTL_SECONDS });
    await redis.del(`auth:magic:${token}`);
    await redis.lpush(`auth:log:${magicData.email}`, JSON.stringify({
      at: new Date().toISOString(), via: 'magic', roleId: magicData.roleId,
      ip: clientIp(req), ua: req.headers['user-agent'] || 'unknown'
    }));
    await redis.ltrim(`auth:log:${magicData.email}`, 0, 49);
  } catch (e) {
    return res.redirect(302, '/?auth=error#portal');
  }

  res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  return res.status(200).send(htmlRedirect('/#portal', 'Welcome to the portal.'));
}

async function handleGoogleStart(req, res) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Google sign-in is not configured.');

  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/google/callback`;

  const state = randomToken(24);
  try {
    await redis.set(`auth:oauth_state:${state}`, '1', { ex: 600 });
  } catch (e) {
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
  return res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

/* ---- router --------------------------------------------------------------- */

export default async function handler(req, res) {
  const action = (req.query?.action || '').trim();

  try {
    switch (action) {
      case 'me':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        return await handleMe(req, res);
      case 'logout':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleLogout(req, res);
      case 'request-link':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleRequestLink(req, res);
      case 'verify':
        if (req.method !== 'GET') return res.status(405).send('Method not allowed');
        return await handleVerify(req, res);
      case 'google-start':
        if (req.method !== 'GET') return res.status(405).send('Method not allowed');
        return await handleGoogleStart(req, res);
      default:
        return res.status(400).json({ error: 'Unknown auth action' });
    }
  } catch (e) {
    console.error('[auth] handler error:', e.message);
    if (req.method === 'GET' && (action === 'verify' || action === 'google-start')) {
      return res.redirect(302, '/?auth=error#portal');
    }
    return res.status(500).json({ error: 'Auth error' });
  }
}
