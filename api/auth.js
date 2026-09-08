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

import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import {
  findRole,
  publicSession,
  buildSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  SESSION_TTL_SECONDS
} from './auth/_allowlist.js';
import { peekAccount } from './_tokens.js';
import { onNewSignup } from './_welcome.js';
import { fetchLinkedInAds } from './_adlibrary.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const EMAILJS_SERVICE_ID = 'service_ywioabe';
const EMAILJS_TEMPLATE_ID = 'template_gtqow85';
const EMAILJS_PUBLIC_KEY = '964Wa83HevoEa5KnS';

/* Disposable/temporary email domains — blocked from the free roast sign-up so the
   free tier can't be farmed with throwaway addresses. Not exhaustive; covers the
   common ones. */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','guerrillamail.info','sharklasers.com','grr.la',
  '10minutemail.com','10minutemail.net','temp-mail.org','tempmail.com','tempmail.net',
  'yopmail.com','yopmail.fr','throwawaymail.com','getnada.com','nada.email','maildrop.cc',
  'dispostable.com','mailnesia.com','trashmail.com','trashmail.de','mintemail.com',
  'fakeinbox.com','tempinbox.com','mailcatch.com','mohmal.com','emailondeck.com',
  'spam4.me','tempr.email','discard.email','moakt.com','tempmailo.com','1secmail.com',
  'inboxkitten.com','mailpoof.com','burnermail.io','tempmailaddress.com','mail-temp.com'
]);
function isDisposableEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return DISPOSABLE_DOMAINS.has(email.slice(at + 1));
}

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
<title>AdRoast: Signing you in</title>
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
  /* Sliding renewal: every time the app checks the session, push the expiry back
     out to the full TTL and refresh the cookie. Active users therefore stay
     signed in indefinitely; only a 90-day gap of inactivity logs them out. */
  try {
    await redis.expire(`auth:session:${sessionToken}`, SESSION_TTL_SECONDS);
    res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
  } catch (e) { /* non-fatal: session still valid, just not re-extended this call */ }
  const out = { success: true, session: publicSession(session) };
  /* For roast-tool accounts, surface the plan + remaining token balance so the
     UI can show "N roasts left" and gate at zero. Read-only (no consume). */
  if (session.mode === 'roast' && session.email) {
    try {
      const acct = await peekAccount(redis, session.email);
      if (acct) { out.plan = acct.plan; out.tokens = acct.tokens; }
    } catch (e) { /* non-fatal */ }
  }
  return res.status(200).json(out);
}

/* Every ad this signed-in account has roasted, newest first. Reads the global
   roast:index (compact summaries carry the account email) and filters to the
   session's own email, so a user only ever sees their own roasts. Powers the
   "My roasted ads" dashboard (by-company and all-mixed views). */
async function handleMyRoasts(req, res) {
  const sessionToken = readSessionCookie(req);
  if (!sessionToken) return res.status(401).json({ error: 'Not signed in' });
  let session = null;
  try {
    const raw = await redis.get(`auth:session:${sessionToken}`);
    if (raw) session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return res.status(500).json({ error: 'Session lookup failed' });
  }
  if (!session || !session.email) return res.status(401).json({ error: 'Session expired' });
  const email = String(session.email).toLowerCase();
  // Include any prior emails (aliases from a verified email change) so past roasts still show.
  const emails = new Set([email]);
  try { const al = await redis.smembers(`roast:aliases:${email}`); (al || []).forEach(a => emails.add(String(a).toLowerCase())); } catch (e) {}
  let roasts = [];
  try {
    const raw = await redis.lrange('roast:index', 0, 999);
    roasts = (raw || [])
      .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
      .filter(r => r && emails.has((r.email || '').toLowerCase()))
      .map(r => ({ reportId: r.reportId, ts: r.ts, company: r.company || '', platform: r.platform || '', icp: r.icp || '', adScore: r.adScore, lpScore: r.lpScore, matchScore: r.matchScore, img: r.img || null }));
  } catch (e) { /* redis down -> return an empty list rather than erroring the dashboard */ }
  /* Enrich each roast with its ad creative so the dashboard shows the real ad (like the live
     board), not just a score. Newer roasts carry img in the summary; for older ones, pull the
     creative hotlink from the report. Bounded to a page of the user's own roasts (dozens), and
     we only include a hotlink URL (never the heavy inlined base64) to keep the response small. */
  try {
    const need = roasts.filter(r => !r.img && r.reportId).slice(0, 60);
    await Promise.all(need.map(async (r) => {
      try {
        const rep = await redis.get(`roast:report:${r.reportId}`);
        const rec = rep ? (typeof rep === 'string' ? JSON.parse(rep) : rep) : null;
        if (rec && rec.adImageUrl) r.img = rec.adImageUrl;
      } catch (e) { /* skip this one */ }
    }));
  } catch (e) { /* enrichment is best-effort */ }
  return res.status(200).json({ success: true, email, roasts });
}

/* Move a roast account from one email to another. Renames the account record (plan +
   tokens) and the accounts set, moves the last-roast pointer, and records the old email as
   an ALIAS of the new one so past roasts (roast:index rows keyed by the old email) still
   surface under the new email, without a risky rewrite of the shared roast:index list. */
async function migrateAccountEmail(oldRaw, newRaw) {
  const oldEmail = String(oldRaw || '').toLowerCase();
  const newEmail = String(newRaw || '').toLowerCase();
  if (!oldEmail || !newEmail || oldEmail === newEmail) return;
  try {
    const raw = await redis.get(`roast:acct:${oldEmail}`);
    if (raw) {
      const existing = await redis.get(`roast:acct:${newEmail}`);
      if (!existing) await redis.set(`roast:acct:${newEmail}`, typeof raw === 'string' ? raw : JSON.stringify(raw));
      await redis.del(`roast:acct:${oldEmail}`);
    }
    try { await redis.sadd('roast:accounts', newEmail); await redis.srem('roast:accounts', oldEmail); } catch (e) {}
    try {
      const lr = await redis.get(`roast:last:${oldEmail}`);
      if (lr) { await redis.set(`roast:last:${newEmail}`, typeof lr === 'string' ? lr : JSON.stringify(lr), { ex: 60 * 60 * 24 * 30 }); await redis.del(`roast:last:${oldEmail}`); }
    } catch (e) {}
    try {
      await redis.sadd(`roast:aliases:${newEmail}`, oldEmail);
      const prev = await redis.smembers(`roast:aliases:${oldEmail}`);
      if (prev && prev.length) await redis.sadd(`roast:aliases:${newEmail}`, ...prev);
      await redis.del(`roast:aliases:${oldEmail}`);
    } catch (e) {}
  } catch (e) { /* best-effort: the new session still issues below */ }
}

/* Start a verified email change for the signed-in roast account: emails a confirmation
   link to the NEW address carrying `changeFrom`; the change only applies when that link is
   clicked (handleVerify migrates the account then). Never trusts a client-supplied current
   email, only the session's. */
async function handleChangeEmailRequest(req, res) {
  const sessionToken = readSessionCookie(req);
  if (!sessionToken) return res.status(401).json({ error: 'Not signed in' });
  let session = null;
  try {
    const raw = await redis.get(`auth:session:${sessionToken}`);
    if (raw) session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return res.status(500).json({ error: 'Session lookup failed' }); }
  if (!session || !session.email || session.mode !== 'roast') return res.status(401).json({ error: 'Session expired' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const newEmail = ((body && body.email) || '').trim().toLowerCase();
  const oldEmail = String(session.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (newEmail === oldEmail) return res.status(400).json({ error: 'That is already your email.' });
  try { const existing = await redis.get(`roast:acct:${newEmail}`); if (existing) return res.status(409).json({ error: 'That email already has an AdRoast account. Sign in with it instead.' }); } catch (e) {}
  const token = randomToken(24);
  try {
    await redis.set(`auth:magic:${token}`, JSON.stringify({ email: newEmail, mode: 'roast', changeFrom: oldEmail, createdAt: Date.now() }), { ex: 15 * 60 });
  } catch (e) { return res.status(500).json({ error: 'Could not start the email change. Please try again.' }); }
  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const magicLink = `${proto}://${host}/api/auth?action=verify&token=${encodeURIComponent(token)}`;
  try {
    const message =
`You asked to change your AdRoast account email to this address.

Click the link below to confirm the change. It expires in 15 minutes and can only be used once. Your plan and roast history move with you.

${magicLink}

If you didn't request this, you can ignore this email and nothing changes.

AdRoast`;
    const emailPayload = {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: { to_email: newEmail, subject: 'Confirm your new AdRoast email', message }
    };
    if (process.env.EMAILJS_PRIVATE_KEY) emailPayload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
    const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload) });
    if (!emailRes.ok) return res.status(500).json({ error: 'Could not send the confirmation email. Please try again.' });
  } catch (e) { return res.status(500).json({ error: 'Could not send the confirmation email. Please try again.' }); }
  return res.status(200).json({ success: true, message: `Check ${newEmail} for a link to confirm the change.` });
}

/* Open the Stripe billing portal for the SIGNED-IN account (subscription + invoices).
   Uses the session's own email (never a client-supplied one) so a user can only ever
   reach their own billing. Returns { url } to redirect to, or no_customer for accounts
   that have never paid (the UI then sends them to pricing instead). */
async function handleBillingPortal(req, res) {
  const sessionToken = readSessionCookie(req);
  if (!sessionToken) return res.status(401).json({ error: 'Not signed in' });
  let session = null;
  try {
    const raw = await redis.get(`auth:session:${sessionToken}`);
    if (raw) session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return res.status(500).json({ error: 'Session lookup failed' });
  }
  if (!session || !session.email) return res.status(401).json({ error: 'Session expired' });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'billing_unconfigured' });
  const siteUrl = process.env.SITE_URL || 'https://adroast.in';
  try {
    const cr = await fetch('https://api.stripe.com/v1/customers?email=' + encodeURIComponent(session.email) + '&limit=1', { headers: { 'Authorization': `Bearer ${key}` } });
    const cd = await cr.json();
    const customer = cd && cd.data && cd.data[0] && cd.data[0].id;
    if (!customer) return res.status(404).json({ error: 'no_customer' });
    const pr = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customer, return_url: siteUrl }).toString()
    });
    const pd = await pr.json();
    if (!pr.ok || !pd.url) return res.status(500).json({ error: 'portal_failed' });
    return res.status(200).json({ success: true, url: pd.url });
  } catch (e) {
    return res.status(500).json({ error: 'portal_error' });
  }
}

/* ---- API keys (for the personal API / MCP server) --------------------------------------
   A roast account gets one long-lived API key so scripts and the AdRoast MCP server can act
   as that account (roast an ad, pull the live-ads board) without a browser session. Stored two
   ways: roast:apikeyfor:<email> (forward, to show/rotate in My Account) and roast:apikey:<key>
   (reverse, so roast.js / mcp.js can resolve a key back to its email). Keys never expire; a
   rotate deletes the old reverse mapping so the previous key stops working immediately. */
function newApiKey() {
  return 'ak_live_' + crypto.randomBytes(24).toString('hex');
}
async function getOrCreateApiKey(email, { rotate = false } = {}) {
  const fwd = `roast:apikeyfor:${email}`;
  let key = rotate ? null : await redis.get(fwd);
  if (key) return String(key);
  const prev = rotate ? await redis.get(fwd) : null;
  key = newApiKey();
  await redis.set(fwd, key);
  await redis.set(`roast:apikey:${key}`, email);
  if (prev) { try { await redis.del(`roast:apikey:${prev}`); } catch (e) {} }
  return key;
}
async function sessionRoastEmail(req) {
  const sessionToken = readSessionCookie(req);
  if (!sessionToken) return null;
  try {
    const raw = await redis.get(`auth:session:${sessionToken}`);
    const s = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    if (s && s.mode === 'roast' && s.email) return String(s.email).trim().toLowerCase();
  } catch (e) {}
  return null;
}
async function handleApiKey(req, res) {
  const email = await sessionRoastEmail(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const rotate = req.method === 'POST' && ((req.body && req.body.rotate) || req.query.rotate === '1');
  try {
    const key = await getOrCreateApiKey(email, { rotate: !!rotate });
    return res.status(200).json({ success: true, email, apiKey: key, mcpUrl: 'https://www.adroast.in/api/mcp?key=' + key });
  } catch (e) {
    console.error('[auth] api-key error:', e.message);
    return res.status(500).json({ error: 'Could not issue an API key. Please try again.' });
  }
}

/* The account's company roster (powers the logged-in sidebar + board landing). Prefers the
   per-account hash roast:cos:<email>; backfills from the global roast index for accounts that
   roasted before that roster existed. Newest-first. */
async function handleMyCompanies(req, res) {
  const email = await sessionRoastEmail(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const domOf = (u) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[\/?#].*$/, '');
  const realDom = (d) => !!(d && d.indexOf('.') > -1);
  try {
    // 1) Load the already-resolved roster (from new roasts + prior enrichment).
    let hash = {};
    try { hash = (await redis.hgetall(`roast:cos:${email}`)) || {}; } catch (e) { hash = {}; }
    const bySite = {}; // keyed by a real domain
    for (const v of Object.values(hash)) {
      let c; try { c = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { continue; }
      const d = domOf(c && (c.site || c.domain));
      if (realDom(d)) bySite[d] = { domain: d, name: (c.name || d), site: c.site || d, ts: c.ts || 0 };
    }
    // 2) Scan the FULL roast history (one lrange) so the roster is complete, not just recent roasts.
    const raw = await redis.lrange('roast:index', 0, 999);
    const pending = {}; // companies whose real domain we still need to resolve, keyed by a temp key
    for (const r of (raw || [])) {
      let s; try { s = typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { continue; }
      if (!s || String(s.email || '').toLowerCase() !== email) continue;
      const d = domOf(s.website) || (realDom(s.domain) ? s.domain : '');
      if (realDom(d)) {
        if (!bySite[d] || (s.ts || 0) > bySite[d].ts) bySite[d] = { domain: d, name: s.company || d, site: s.website || d, ts: s.ts || 0 };
        continue;
      }
      // No usable domain in the summary: remember the newest report to resolve it from.
      const k = String(s.company || '').toLowerCase().replace(/[^a-z0-9]/g, '') || (s.reportId || '');
      if (k && (!pending[k] || (s.ts || 0) > pending[k].ts)) pending[k] = { name: s.company || k, ts: s.ts || 0, reportId: s.reportId };
    }
    // 3) Resolve pending companies from their report record (bounded), skipping any we already have.
    const need = Object.values(pending).slice(0, 40);
    await Promise.all(need.map(async (c) => {
      try {
        const rec = await redis.get(`roast:report:${c.reportId}`);
        const o = rec ? (typeof rec === 'string' ? JSON.parse(rec) : rec) : null;
        const site = (o && (o.website || o.landingUrl || o.adUrl)) || '';
        const d = domOf(site);
        if (realDom(d) && (!bySite[d] || c.ts > bySite[d].ts)) bySite[d] = { domain: d, name: c.name || d, site: site, ts: c.ts };
      } catch (e) {}
    }));
    const companies = Object.values(bySite).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    // Cache the resolved roster so subsequent calls skip the report fetches.
    try {
      const hset = {};
      for (const c of companies) hset[c.domain] = JSON.stringify(c);
      if (Object.keys(hset).length) await redis.hset(`roast:cos:${email}`, hset);
    } catch (e) {}
    return res.status(200).json({ success: true, companies });
  } catch (e) {
    return res.status(200).json({ success: true, companies: [] });
  }
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

If you didn't request this, you can ignore this email. The link won't grant access without your password too.

AdRoast`;
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
  /* Before the token is read we can't know whether it was a roast or portal link,
     and most sign-ins are roast. So failures here return to the roaster with a
     clear message (not the portal gate). */
  if (!token) return res.redirect(302, '/?signin=expired');

  let magicData = null;
  let fromGrace = false;
  try {
    const raw = await redis.get(`auth:magic:${token}`);
    if (raw) {
      magicData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } else {
      /* Not in the live key. Email clients and browsers often PREFETCH the link,
         which consumes a single-use token before the human actually clicks it. To
         survive that, a just-consumed token is kept under a short grace key so the
         real click still signs in. */
      const doneRaw = await redis.get(`auth:magic_done:${token}`);
      if (doneRaw) { magicData = typeof doneRaw === 'string' ? JSON.parse(doneRaw) : doneRaw; fromGrace = true; }
    }
  } catch (e) {
    return res.redirect(302, '/?signin=error');
  }
  if (!magicData) return res.redirect(302, '/?signin=expired');

  /* Verified email change: migrate the account from the old email to this one BEFORE issuing
     the session, so the new session already reflects the moved plan + roast history. */
  if (magicData.mode === 'roast' && magicData.changeFrom) {
    try { await migrateAccountEmail(magicData.changeFrom, magicData.email); } catch (e) {}
  }

  const isRoast = magicData.mode === 'roast';
  const sessionToken = randomToken(32);
  try {
    await redis.set(`auth:session:${sessionToken}`, JSON.stringify(isRoast ? {
      email: magicData.email, mode: 'roast', via: 'magic', createdAt: Date.now()
    } : {
      email: magicData.email, roleId: magicData.roleId, mode: magicData.mode,
      partnerId: magicData.partnerId, clientId: magicData.clientId, via: 'magic', createdAt: Date.now()
    }), { ex: SESSION_TTL_SECONDS });
    if (!fromGrace) {
      /* Move the token from live to a 3-minute grace key so a prefetch+click pair
         both succeed, then it's gone for good. */
      await redis.set(`auth:magic_done:${token}`, JSON.stringify(magicData), { ex: 180 });
      await redis.del(`auth:magic:${token}`);
      await redis.lpush(`auth:log:${magicData.email}`, JSON.stringify({
        at: new Date().toISOString(), via: 'magic', roleId: magicData.roleId || 'roast',
        ip: clientIp(req), ua: req.headers['user-agent'] || 'unknown'
      }));
      await redis.ltrim(`auth:log:${magicData.email}`, 0, 49);
      /* Onboarding for brand-new roast accounts (once ever, fail-open). Only on
         the real click, not the prefetch grace path. Routes to Loops when set. */
      if (isRoast) await onNewSignup(redis, magicData.email);
    }
  } catch (e) {
    return res.redirect(302, isRoast ? '/?signin=error' : '/?auth=error#portal');
  }

  res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  return res.status(200).send(htmlRedirect(isRoast ? '/?signedin=1' : '/#portal', isRoast ? 'Signed in. Back to your roast.' : 'Welcome to the portal.'));
}

async function handleGoogleStart(req, res) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Google sign-in is not configured.');

  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/google/callback`;

  const mode = (req.query?.mode === 'roast') ? 'roast' : 'portal';
  const state = randomToken(24);
  try {
    await redis.set(`auth:oauth_state:${state}`, mode, { ex: 600 });
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

/* Passwordless sign-up/sign-in for the PUBLIC roast tool (any email, no allowlist).
   Kept separate from request-link (which is portal-only, allowlist + password). */
async function handleRoastLink(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (isDisposableEmail(email)) return res.status(400).json({ error: 'Please use a work email. Temporary email addresses are not supported.' });

  try {
    const emailKey = `auth:ratelimit:email:${email}`;
    const ipKey = `auth:ratelimit:ip:${clientIp(req)}`;
    const ec = await redis.incr(emailKey); if (ec === 1) await redis.expire(emailKey, 3600);
    const ic = await redis.incr(ipKey); if (ic === 1) await redis.expire(ipKey, 3600);
    if (ec > 5 || ic > 30) return res.status(429).json({ error: 'Too many attempts. Please try again in an hour.' });
  } catch (e) { /* fail open */ }

  const token = randomToken(24);
  try {
    await redis.set(`auth:magic:${token}`, JSON.stringify({ email, mode: 'roast', createdAt: Date.now() }), { ex: 15 * 60 });
  } catch (e) {
    return res.status(500).json({ error: 'Could not generate a sign-in link. Please try again.' });
  }

  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const magicLink = `${proto}://${host}/api/auth?action=verify&token=${encodeURIComponent(token)}`;
  try {
    const message = `Click to sign in to AdRoast and get your free roast. This link expires in 15 minutes and can only be used once.\n\n${magicLink}\n\nIf you didn't request this, you can ignore this email.\n\nAdRoast`;
    const emailPayload = {
      service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY,
      template_params: { to_email: email, subject: 'Your AdRoast sign-in link', message }
    };
    if (process.env.EMAILJS_PRIVATE_KEY) emailPayload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
    const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload)
    });
    if (!emailRes.ok) {
      console.error('[auth roast-link] EmailJS error:', emailRes.status, await emailRes.text());
      return res.status(500).json({ error: "Couldn't send the email. Try signing in with Google instead." });
    }
  } catch (e) {
    return res.status(500).json({ error: "Couldn't send the email. Try signing in with Google instead." });
  }
  return res.status(200).json({ success: true, message: 'Check your inbox for a sign-in link (expires in 15 min).' });
}

/* ---- router --------------------------------------------------------------- */

// Fetch a creative image as base64, robust against licdn's occasional 403 (retry w/ referer).
async function _bfImage(url) {
  const attempts = [
    { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', 'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8' },
    { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', 'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8', 'Referer': 'https://www.linkedin.com/', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'cross-site' }
  ];
  for (let a = 0; a < attempts.length; a++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 9000);
      const r = await fetch(url, { headers: attempts[a], signal: c.signal });
      clearTimeout(t);
      const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (r.ok && /^image\/(png|jpe?g|gif|webp|avif)$/.test(ct)) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 0 && buf.length <= 4_500_000) return { b64: buf.toString('base64'), type: ct === 'image/jpg' ? 'image/jpeg' : ct };
      }
    } catch (e) { /* try next */ }
  }
  return null;
}
function _bfNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
// Distinctive words (>=4 alnum chars) for fuzzy ad matching, minus common filler.
const _BF_STOP = new Set(['with', 'your', 'that', 'this', 'from', 'have', 'more', 'they', 'them', 'what', 'when', 'were', 'been', 'their', 'about', 'would', 'there', 'which', 'these', 'other', 'into', 'than', 'then', 'also', 'here', 'just', 'like', 'over', 'only', 'most', 'some', 'time', 'team', 'help', 'free', 'code', 'security', 'company']);
function _bfWords(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !_BF_STOP.has(w)); }

// Recover missing ad creatives on OLD roasts: re-pull the company's live LinkedIn ads, match the
// stored roast to a live creative (by headline/body), and persist the image onto the EXISTING report
// (same id, no duplicate). Only touches roasts that currently have NO creative. Client drives it one
// company per call (pass ?company= & the ids to attempt) to stay inside the function time limit.
async function handleBackfillCreatives(req, res) {
  const email = await sessionRoastEmail(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const company = String(body.company || req.query.company || '').trim();
  let ids = Array.isArray(body.ids) ? body.ids.map(String) : String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!company || !ids.length) return res.status(400).json({ error: 'company and ids required' });

  // Load each target record; skip any that already carry a creative.
  const targets = [];
  for (const id of ids.slice(0, 12)) {
    try {
      const raw = await redis.get(`roast:report:${id}`);
      const rec = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (!rec) { targets.push({ id, status: 'no_record' }); continue; }
      if (String(rec.email || '').toLowerCase() !== email.toLowerCase()) { targets.push({ id, status: 'not_yours' }); continue; }
      if (rec.adScreenshot || rec.adCreativeKey || (rec.adImageUrl && /^https?:\/\//i.test(rec.adImageUrl))) { targets.push({ id, status: 'already_ok', rec }); continue; }
      targets.push({ id, status: 'pending', rec });
    } catch (e) { targets.push({ id, status: 'error' }); }
  }
  // Reset mode: undo a previously-written (possibly wrong) creative so a roast falls back to no image.
  if (req.query.reset === '1') {
    for (const t of targets) {
      if (!t.rec) continue;
      const rec = t.rec;
      delete rec.adScreenshot; delete rec.adScreenshotType; delete rec.adCreativeKey; delete rec.adImageUrl;
      try { await redis.del(`roast:creative:${t.id}`); } catch (e) {}
      try { await redis.set(`roast:report:${t.id}`, JSON.stringify(rec), { ex: 60 * 60 * 24 * 365 }); } catch (e) {}
      try {
        const list = await redis.lrange('roast:index', 0, 999);
        for (let i = 0; i < list.length; i++) { let s; try { s = typeof list[i] === 'string' ? JSON.parse(list[i]) : list[i]; } catch (e) { continue; } if (s && s.reportId === t.id) { s.img = null; await redis.lset('roast:index', i, JSON.stringify(s)); break; } }
      } catch (e) {}
      t.status = 'reset';
    }
    return res.status(200).json({ company, results: targets.map(({ rec, ...r }) => r) });
  }

  const pending = targets.filter(t => t.status === 'pending');
  if (!pending.length) return res.status(200).json({ company, results: targets.map(({ rec, ...r }) => r) });

  // Pull the company's live LinkedIn ads once.
  const pull = await fetchLinkedInAds({ company, limit: 24 });
  const liveAds = (pull.ok ? pull.ads : []).filter(a => a.img);
  const debug = req.query.debug === '1';
  const dbg = debug ? { liveAds: liveAds.map(a => ({ head: (a.head || '').slice(0, 60), body: (a.body || '').slice(0, 80), img: !!a.img })) } : null;
  if (!liveAds.length) {
    pending.forEach(t => { t.status = 'no_live_ads'; });
    return res.status(200).json({ company, pullReason: pull.reason || null, results: targets.map(({ rec, ...r }) => r), debug: dbg });
  }

  const wordsOf = (s) => { const set = new Set(); (_bfWords(s)).forEach(w => set.add(w)); return set; };
  // Match + persist for each pending roast.
  for (const t of pending) {
    const rec = t.rec;
    const recCopy = _bfNorm(rec.adCopy);
    const recWords = wordsOf(rec.adCopy);
    let match = null;
    if (recWords.size >= 2) {
      // The live ad must BE the roasted ad, not a topical cousin: rank by how much of the LIVE
      // ad's own distinctive vocabulary is contained in the stored copy (ratio), not raw overlap.
      // A different current ad shares only a few generic words; the same ad shares nearly all.
      let best = null, bestRatio = 0, bestShared = 0;
      for (const a of liveAds) {
        const lw = wordsOf((a.head || '') + ' ' + (a.body || ''));
        if (lw.size < 4) continue; // too little text to judge identity
        let shared = 0; lw.forEach(w => { if (recWords.has(w)) shared++; });
        const ratio = shared / lw.size;
        if (ratio > bestRatio) { bestRatio = ratio; bestShared = shared; best = a; }
      }
      if (best && bestRatio >= 0.6 && bestShared >= 4) match = best;
      if (debug) t.dbg = { recWords: recWords.size, bestShared, bestRatio: Math.round(bestRatio * 100) / 100 };
    }
    // Unambiguous fallback: no usable copy but the company runs exactly one live creative.
    if (!match && recWords.size < 2 && liveAds.length === 1) match = liveAds[0];
    if (!match) { t.status = 'no_match'; continue; }

    const img = await _bfImage(match.img);
    if (!img) { t.status = 'img_fetch_failed'; continue; }
    try {
      rec.adImageUrl = match.img;
      if (img.b64.length < 700000) { rec.adScreenshot = img.b64; rec.adScreenshotType = img.type; }
      else {
        await redis.set(`roast:creative:${t.id}`, JSON.stringify({ b64: img.b64, type: img.type }), { ex: 60 * 60 * 24 * 365 });
        rec.adCreativeKey = true; rec.adScreenshotType = img.type;
      }
      await redis.set(`roast:report:${t.id}`, JSON.stringify(rec), { ex: 60 * 60 * 24 * 365 });
      // Reflect the creative in the roast:index summary so dashboards/board previews show it too.
      try {
        const list = await redis.lrange('roast:index', 0, 999);
        for (let i = 0; i < list.length; i++) {
          let s; try { s = typeof list[i] === 'string' ? JSON.parse(list[i]) : list[i]; } catch (e) { continue; }
          if (s && s.reportId === t.id) { s.img = match.img; await redis.lset('roast:index', i, JSON.stringify(s)); break; }
        }
      } catch (e) { /* summary update is best-effort */ }
      t.status = 'recovered';
    } catch (e) { t.status = 'save_failed'; }
  }
  return res.status(200).json({ company, liveAds: liveAds.length, results: targets.map(({ rec, ...r }) => r), debug: dbg });
}

// Remove roasts from the dashboard listing (roast:index) without destroying the report record
// (so any shared /report/<id> link still resolves). Used to clear creative-less duplicate cards.
async function handleRemoveRoasts(req, res) {
  const email = await sessionRoastEmail(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const ids = (Array.isArray(body.ids) ? body.ids.map(String) : String(req.query.ids || '').split(',')).map(s => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const results = [];
  let list;
  try { list = await redis.lrange('roast:index', 0, 999); } catch (e) { return res.status(500).json({ error: 'index read failed' }); }
  const idset = new Set(ids);
  for (const raw of list) {
    let s; try { s = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { continue; }
    if (!s || !idset.has(s.reportId)) continue;
    // Ownership: only remove the caller's own roasts.
    if (String(s.email || '').toLowerCase() !== email.toLowerCase()) { results.push({ id: s.reportId, status: 'not_yours' }); idset.delete(s.reportId); continue; }
    try { await redis.lrem('roast:index', 0, raw); results.push({ id: s.reportId, status: 'removed' }); }
    catch (e) { results.push({ id: s.reportId, status: 'error' }); }
    idset.delete(s.reportId);
  }
  for (const missing of idset) results.push({ id: missing, status: 'not_in_index' });
  return res.status(200).json({ results });
}

// Repair the per-account company roster hash (roast:cos): correct a company's cached name/site or
// delete a stray entry. Session-gated to the caller's own roster.
async function handleFixCos(req, res) {
  const email = await sessionRoastEmail(req);
  if (!email) return res.status(401).json({ error: 'Not signed in' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const key = `roast:cos:${email}`;
  const dels = Array.isArray(body.del) ? body.del : [];
  const sets = Array.isArray(body.set) ? body.set : [];
  const results = { deleted: [], set: [] };
  for (const d of dels) { if (d) { try { await redis.hdel(key, String(d)); results.deleted.push(String(d)); } catch (e) {} } }
  for (const s of sets) {
    if (s && s.domain) {
      try { await redis.hset(key, { [String(s.domain)]: JSON.stringify({ domain: String(s.domain), name: s.name || String(s.domain), site: s.site || String(s.domain), ts: Date.now() }) }); results.set.push(String(s.domain)); } catch (e) {}
    }
  }
  return res.status(200).json(results);
}

export default async function handler(req, res) {
  const action = (req.query?.action || '').trim();

  try {
    switch (action) {
      case 'me':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        return await handleMe(req, res);
      case 'my-roasts':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        return await handleMyRoasts(req, res);
      case 'billing-portal':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        return await handleBillingPortal(req, res);
      case 'api-key':
        if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleApiKey(req, res);
      case 'my-companies':
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        return await handleMyCompanies(req, res);
      case 'backfill-creatives':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleBackfillCreatives(req, res);
      case 'remove-roasts':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleRemoveRoasts(req, res);
      case 'fix-cos':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleFixCos(req, res);
      case 'change-email':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleChangeEmailRequest(req, res);
      case 'logout':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleLogout(req, res);
      case 'request-link':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleRequestLink(req, res);
      case 'verify':
        if (req.method !== 'GET') return res.status(405).send('Method not allowed');
        return await handleVerify(req, res);
      case 'roast-link':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await handleRoastLink(req, res);
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
