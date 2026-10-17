// OAuth 2.1 authorization server for the AdRoast MCP connector (Claude Connectors Directory).
// Claude signs a user in to their AdRoast roast account and gets a bearer token for /api/mcp,
// instead of the user pasting an ?key=ak_... URL. Supports what Claude's client uses:
// Client ID Metadata Documents (CIMD) and Dynamic Client Registration (DCR), S256 PKCE only,
// public clients (token_endpoint_auth_method "none"), rotating refresh tokens.
//
// Underscore prefix => NOT its own Vercel function (Hobby 12-function cap). api/auth.js routes
// action=oauth-* here, and vercel.json rewrites the clean paths:
//   /.well-known/oauth-protected-resource[/api/mcp] -> oauth-prm
//   /.well-known/oauth-authorization-server         -> oauth-asm
//   /oauth/register, /oauth/authorize, /oauth/token  -> oauth-register / -authorize / -token
//
// Redis keys: oauth:client:<id> (DCR + cached CIMD), oauth:req:<rid> (pending consent, 10 min),
// oauth:code:<code> (5 min, single use), oauth:at:<token> (1 h), oauth:rt:<token> (90 days).
import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { readSessionCookie } from './auth/_allowlist.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const ISSUER = 'https://www.adroast.in';
export const MCP_RESOURCE = `${ISSUER}/api/mcp`;
export const PRM_URL = `${ISSUER}/.well-known/oauth-protected-resource`;
const SCOPE = 'roast';
const AT_TTL = 3600;
const RT_TTL = 90 * 24 * 3600;

const rand = (n = 32) => crypto.randomBytes(n).toString('hex');
const parse = (v) => { try { return v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v); } catch (e) { return null; } };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bodyOf = (req) => {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (e) {}
    return Object.fromEntries(new URLSearchParams(b));
  }
  return {};
};
const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-protocol-version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
};
const oauthError = (res, status, error, description) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error, error_description: description });
};

/* ---- discovery -------------------------------------------------------------------------- */

export function handleProtectedResource(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(200).json({
    resource: MCP_RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'AdRoast',
    resource_documentation: `${ISSUER}/mcp`,
  });
}

export function handleAuthServerMetadata(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(200).json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    scopes_supported: [SCOPE, 'offline_access'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    service_documentation: `${ISSUER}/mcp`,
  });
}

/* ---- clients ---------------------------------------------------------------------------- */

// Loopback redirects (Claude Code) match with the port ignored, per RFC 8252.
function redirectAllowed(registered, requested) {
  if (!requested) return false;
  if ((registered || []).includes(requested)) return true;
  let r; try { r = new URL(requested); } catch (e) { return false; }
  if (r.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(r.hostname)) return false;
  return (registered || []).some(u => {
    try { const g = new URL(u); return g.protocol === 'http:' && g.hostname === r.hostname && g.pathname === r.pathname; }
    catch (e) { return false; }
  });
}

async function getClient(clientId) {
  if (!clientId) return null;
  const cached = parse(await redis.get(`oauth:client:${clientId}`));
  if (cached) return cached;
  // CIMD: the client_id is an https URL serving the client's metadata document.
  if (!/^https:\/\//i.test(clientId)) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(clientId, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const doc = await r.json();
    if (!doc || doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
    const client = { client_id: clientId, client_name: doc.client_name || new URL(clientId).hostname, redirect_uris: doc.redirect_uris, cimd: true };
    await redis.set(`oauth:client:${clientId}`, JSON.stringify(client), { ex: 3600 });
    return client;
  } catch (e) {
    return null;
  }
}

export async function handleRegister(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return oauthError(res, 405, 'invalid_request', 'POST only');
  const b = bodyOf(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required');
  for (const u of uris) {
    let p; try { p = new URL(u); } catch (e) { return oauthError(res, 400, 'invalid_redirect_uri', `Not a URL: ${u}`); }
    const loopback = p.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(p.hostname);
    if (p.protocol !== 'https:' && !loopback) return oauthError(res, 400, 'invalid_redirect_uri', `Redirect must be https or loopback: ${u}`);
  }
  const client = {
    client_id: 'mcp_' + rand(16),
    client_name: String(b.client_name || 'MCP client').slice(0, 100),
    redirect_uris: uris,
  };
  await redis.set(`oauth:client:${client.client_id}`, JSON.stringify(client), { ex: 365 * 24 * 3600 });
  return res.status(201).json({
    ...client,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

/* ---- authorize (sign-in + consent) ------------------------------------------------------ */

async function roastSessionEmail(req) {
  const t = readSessionCookie(req);
  if (!t) return null;
  const s = parse(await redis.get(`auth:session:${t}`));
  return s && s.mode === 'roast' && s.email ? String(s.email).trim().toLowerCase() : null;
}

function page(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/favicon.png">
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f7;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;max-width:400px;width:100%}h1{font-size:19px;margin:0 0 12px}p{font-size:14px;line-height:1.55;color:#4b5563;margin:8px 0}
ul{font-size:14px;color:#4b5563;padding-left:18px;line-height:1.6}.btn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:11px;border-radius:8px;font-size:15px;font-weight:600;border:0;cursor:pointer;text-decoration:none;margin-top:10px}
.pri{background:#e8432e;color:#fff}.sec{background:#f3f4f6;color:#1a1a1a}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-top:10px}
.muted{font-size:12px;color:#9ca3af}code{background:#f3f4f6;padding:1px 5px;border-radius:4px}</style></head>
<body><div class="card">${inner}</div></body></html>`;
}

const sendPage = (res, status, title, inner) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  return res.status(status).send(page(title, inner));
};

export async function handleAuthorize(req, res) {
  if (req.method === 'POST') return decide(req, res);
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  const q = req.query || {};

  let rid = String(q.rid || '');
  let pending = rid ? parse(await redis.get(`oauth:req:${rid}`)) : null;

  if (!pending) {
    if (rid) return sendPage(res, 400, 'AdRoast', '<h1>This sign-in request expired</h1><p>Go back to Claude and connect AdRoast again.</p>');
    const client = await getClient(String(q.client_id || ''));
    // Never redirect with an error to an unverified redirect_uri: show it here instead.
    if (!client) return sendPage(res, 400, 'AdRoast', '<h1>Unknown client</h1><p>The app asking to connect is not registered with AdRoast.</p>');
    const redirectUri = String(q.redirect_uri || '');
    if (!redirectAllowed(client.redirect_uris, redirectUri)) return sendPage(res, 400, 'AdRoast', '<h1>Invalid redirect</h1><p>The redirect address does not match the app registration.</p>');
    const back = (error, description) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', error);
      if (description) u.searchParams.set('error_description', description);
      if (q.state) u.searchParams.set('state', String(q.state));
      return res.redirect(302, u.toString());
    };
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    pending = {
      client_id: client.client_id, client_name: client.client_name, redirect_uri: redirectUri,
      code_challenge: String(q.code_challenge), state: q.state != null ? String(q.state) : null,
      scope: String(q.scope || SCOPE), resource: String(q.resource || MCP_RESOURCE),
    };
    rid = rand(16);
    await redis.set(`oauth:req:${rid}`, JSON.stringify(pending), { ex: 600 });
  }

  const next = `/oauth/authorize?rid=${rid}`;
  const host = (() => { try { return new URL(pending.redirect_uri).host; } catch (e) { return ''; } })();
  const email = await roastSessionEmail(req);

  if (!email) {
    return sendPage(res, 200, 'Sign in to AdRoast', `
<h1>Sign in to AdRoast</h1>
<p><strong>${esc(pending.client_name)}</strong> wants to use your AdRoast account. Sign in first.</p>
<a class="btn pri" href="/api/auth?action=google-start&mode=roast&next=${encodeURIComponent(next)}">Continue with Google</a>
<form id="f"><input type="email" id="em" placeholder="Work email" required>
<button class="btn sec" type="submit">Email me a sign-in link</button></form>
<p id="msg" class="muted"></p>
<script>document.getElementById('f').onsubmit=async function(e){e.preventDefault();var m=document.getElementById('msg');m.textContent='Sending...';
try{var r=await fetch('/api/auth?action=roast-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('em').value,next:${JSON.stringify(next)}})});
var d=await r.json();m.textContent=r.ok?'Check your inbox. The link brings you back here to finish connecting.':(d.error||'Could not send the link.');}catch(err){m.textContent='Could not send the link.';}};</script>`);
  }

  return sendPage(res, 200, 'Connect AdRoast', `
<h1>Connect AdRoast to ${esc(pending.client_name)}?</h1>
<p>Signed in as <strong>${esc(email)}</strong>.</p>
<p>It will be able to:</p>
<ul><li>Roast ads and landing pages (uses your plan's roasts)</li><li>Pull and score a company's live ads</li><li>Read your roast reports</li></ul>
<p class="muted">You will be sent back to <code>${esc(host)}</code>.</p>
<form method="POST" action="/oauth/authorize"><input type="hidden" name="rid" value="${esc(rid)}">
<button class="btn pri" name="decision" value="allow">Allow</button>
<button class="btn sec" name="decision" value="deny">Cancel</button></form>`);
}

async function decide(req, res) {
  const b = bodyOf(req);
  const rid = String(b.rid || '');
  const pending = parse(await redis.get(`oauth:req:${rid}`));
  if (!pending) return sendPage(res, 400, 'AdRoast', '<h1>This sign-in request expired</h1><p>Go back to Claude and connect AdRoast again.</p>');
  // SameSite=Lax keeps the session cookie off cross-site POSTs, so a forged form can't consent.
  const email = await roastSessionEmail(req);
  if (!email) return res.redirect(302, `/oauth/authorize?rid=${rid}`);
  await redis.del(`oauth:req:${rid}`);
  const u = new URL(pending.redirect_uri);
  if (pending.state != null) u.searchParams.set('state', pending.state);
  if (b.decision !== 'allow') {
    u.searchParams.set('error', 'access_denied');
    return res.redirect(302, u.toString());
  }
  const code = rand(24);
  await redis.set(`oauth:code:${code}`, JSON.stringify({ ...pending, email }), { ex: 300 });
  u.searchParams.set('code', code);
  return res.redirect(302, u.toString());
}

/* ---- token ------------------------------------------------------------------------------ */

async function issueTokens(email, clientId, scope, resource) {
  const at = 'at_' + rand(24);
  const rt = 'rt_' + rand(24);
  const grant = JSON.stringify({ email, client_id: clientId, scope, resource });
  await redis.set(`oauth:at:${at}`, grant, { ex: AT_TTL });
  await redis.set(`oauth:rt:${rt}`, grant, { ex: RT_TTL });
  return { access_token: at, token_type: 'Bearer', expires_in: AT_TTL, refresh_token: rt, scope };
}

export async function handleToken(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return oauthError(res, 405, 'invalid_request', 'POST only');
  const b = bodyOf(req);
  res.setHeader('Cache-Control', 'no-store');

  if (b.grant_type === 'authorization_code') {
    const code = String(b.code || '');
    const grant = parse(await redis.get(`oauth:code:${code}`));
    if (!grant) return oauthError(res, 400, 'invalid_grant', 'Code is invalid or expired');
    await redis.del(`oauth:code:${code}`);
    if (b.client_id && b.client_id !== grant.client_id) return oauthError(res, 400, 'invalid_grant', 'client_id does not match the code');
    if (b.redirect_uri && b.redirect_uri !== grant.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the code');
    const verifier = String(b.code_verifier || '');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || challenge !== grant.code_challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    return res.status(200).json(await issueTokens(grant.email, grant.client_id, grant.scope, grant.resource));
  }

  if (b.grant_type === 'refresh_token') {
    const rt = String(b.refresh_token || '');
    const grant = parse(await redis.get(`oauth:rt:${rt}`));
    if (!grant) return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
    if (b.client_id && b.client_id !== grant.client_id) return oauthError(res, 400, 'invalid_grant', 'client_id does not match the token');
    await redis.del(`oauth:rt:${rt}`); // rotate: the old refresh token dies with this response
    return res.status(200).json(await issueTokens(grant.email, grant.client_id, grant.scope, grant.resource));
  }

  return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
}

/* ---- used by the MCP server ------------------------------------------------------------- */

export async function emailForAccessToken(token) {
  if (!token || !/^at_[a-f0-9]+$/.test(token)) return null;
  const g = parse(await redis.get(`oauth:at:${token}`));
  return g && g.email ? String(g.email).toLowerCase() : null;
}

// Only same-site consent resumes are allowed as a post-sign-in destination.
export function safeNext(next) {
  const n = String(next || '');
  return /^\/oauth\/authorize\?rid=[a-f0-9]{32}$/.test(n) ? n : '';
}
