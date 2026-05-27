/**
 * Portal access allowlist + helpers shared by /api/auth/* endpoints.
 *
 * Each role has:
 *   - password    — must match what the user submits
 *   - emails      — list of emails authorized for this role
 *   - mode        — 'master' | 'partner' | 'client'  (matches the existing portal modes)
 *   - partnerId?  — for partner/client modes, which partner workspace to land in
 *   - clientId?   — for client-mode access, which specific client
 *
 * Adding a new client = one entry. To add an email = push onto the emails array.
 *
 * The passwords here replace the old client-side PASSWORD_ROUTES map. They no longer
 * ship in the JS bundle — they live in this server-only file.
 */
export const PORTAL_ROLES = [
  {
    id: 'master',
    password: 'CreativeerOU9590',
    mode: 'master',
    emails: ['marina.kogan@adroast.in', 'marina.kogan@brandswithpurpose.us']
  },
  {
    id: 'fractional-demand',
    password: 'PositioningFD90',
    mode: 'partner',
    partnerId: 'fractional-demand',
    emails: ['chris@fractionaldemand.com']
  },
  {
    id: 'aikido-security',
    password: 'DojoSec90',
    mode: 'partner',
    partnerId: 'aikido-security',
    emails: ['willem@aikido.dev', 'lieven@aikido.dev', 'madeline@aikido.dev']
  }
];

/**
 * Find a role that matches the given (email, password) combination.
 * Returns the role object or null. Email match is case-insensitive.
 */
export function findRole(email, password) {
  if (!email || !password) return null;
  const normEmail = String(email).trim().toLowerCase();
  for (const role of PORTAL_ROLES) {
    if (role.password !== password) continue;
    if (role.emails.map(e => e.toLowerCase()).includes(normEmail)) {
      return { ...role, email: normEmail };
    }
  }
  return null;
}

/** Build a session payload that's safe to expose to the frontend (no password). */
export function publicSession(role) {
  return {
    email: role.email,
    mode: role.mode,
    partnerId: role.partnerId || null,
    clientId: role.clientId || null
  };
}

/** Cookie name + standard attributes used across endpoints. */
export const SESSION_COOKIE = 'adroast_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function buildSessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  /* HttpOnly = no JS access (XSS protection). Secure = HTTPS only.
     SameSite=Lax = allows top-level GET navigation (magic-link click). */
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Parse the session cookie from a request's headers. */
export function readSessionCookie(req) {
  const cookieHeader = req.headers?.cookie || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}
