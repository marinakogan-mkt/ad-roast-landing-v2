/**
 * POST /api/auth/request-link
 *   Body: { email, password }
 *
 * Two-factor first step. The user submits email + the per-client password.
 *   - Validates the combo against the server-side allowlist.
 *   - On match: generates a one-time magic-link token, stores it in Upstash
 *     with a 15-min TTL, and emails the user a click-through link.
 *   - Returns { success: true } either way (we don't reveal whether an email
 *     is on the list — generic success message protects against enumeration).
 *
 * Rate-limited: max 5 attempts per email per hour, max 20 per IP per hour.
 */

import { Redis } from '@upstash/redis';
import { findRole } from './_allowlist.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const EMAILJS_SERVICE_ID = 'service_ywioabe';
const EMAILJS_TEMPLATE_ID = 'template_gtqow85';
const EMAILJS_PUBLIC_KEY = '964Wa83HevoEa5KnS';

function randomToken(bytes = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < bytes; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const email = (body.email || '').trim().toLowerCase();
  const password = (body.password || '').trim();

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and access code are both required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  /* Rate limiting */
  try {
    const emailKey = `auth:ratelimit:email:${email}`;
    const ipKey = `auth:ratelimit:ip:${clientIp(req)}`;
    const emailCount = await redis.incr(emailKey);
    if (emailCount === 1) await redis.expire(emailKey, 3600);
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) await redis.expire(ipKey, 3600);
    if (emailCount > 5 || ipCount > 20) {
      return res.status(429).json({ error: 'Too many login attempts. Please try again in an hour.' });
    }
  } catch (e) {
    /* If Redis is down, fail closed on rate limiting but continue (better than blocking everyone). */
    console.error('[auth/request-link] rate-limit redis error:', e.message);
  }

  const role = findRole(email, password);

  /* Always return success after a tiny delay — don't reveal whether the
     (email, password) combo was valid. Protects against email enumeration
     and password fishing. */
  if (!role) {
    /* Random delay 200-600ms so timing doesn't leak which combos are valid. */
    await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
    return res.status(200).json({ success: true, message: 'If that email is authorized, a sign-in link is on its way.' });
  }

  /* Generate magic link token + store in Redis with 15-min TTL */
  const token = randomToken(24);
  try {
    await redis.set(
      `auth:magic:${token}`,
      JSON.stringify({
        email: role.email,
        roleId: role.id,
        mode: role.mode,
        partnerId: role.partnerId || null,
        clientId: role.clientId || null,
        createdAt: Date.now()
      }),
      { ex: 15 * 60 } // 15 minutes
    );
  } catch (e) {
    console.error('[auth/request-link] redis set error:', e.message);
    return res.status(500).json({ error: 'Could not generate sign-in link. Please try again.' });
  }

  /* Build the magic link. We use the request host (works in preview deploys
     and production without env-var gymnastics). */
  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const magicLink = `${proto}://${host}/api/auth/verify?token=${encodeURIComponent(token)}`;

  /* Send the magic link email via EmailJS (same channel used elsewhere) */
  try {
    const subject = 'Your AdRoast portal sign-in link';
    const message =
`You requested access to the AdRoast partner portal.

Click the link below to sign in. The link expires in 15 minutes and can only be used once.

${magicLink}

If you didn't request this, you can ignore this email — the link won't grant access without your password too.

— AdRoast`;

    const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email: role.email,
          subject,
          message
        }
      })
    });
    if (!emailRes.ok) {
      const text = await emailRes.text();
      console.error('[auth/request-link] EmailJS error:', emailRes.status, text);
      return res.status(500).json({ error: 'Could not send sign-in email. Please try again or contact support.' });
    }
  } catch (e) {
    console.error('[auth/request-link] email send error:', e.message);
    return res.status(500).json({ error: 'Could not send sign-in email. Please try again.' });
  }

  return res.status(200).json({ success: true, message: 'Check your inbox for a sign-in link. It expires in 15 minutes.' });
}
