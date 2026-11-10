/**
 * GET /api/portal-data
 *
 * Returns ONLY the portal data the authenticated user is allowed to see.
 * The full portalData never ships in the browser bundle — each session gets
 * a filtered slice:
 *
 *   master            -> everything (all partners + all direct clients)
 *   partner <id>      -> just that partner (and its clients); no direct clients
 *   client <clientId> -> just that one direct client (under directClients);
 *                        no partners, no other clients
 *
 * 401 if there's no valid session.
 */

import { Redis } from '@upstash/redis';
import { readSessionCookie } from './auth/_allowlist.js';
import { portalData } from './_portal-data.js';

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
    console.error('[portal-data] session lookup error:', e.message);
    return res.status(500).json({ error: 'Session lookup failed' });
  }
  if (!session) {
    return res.status(401).json({ error: 'Session expired' });
  }
  /* Roast-tool accounts (mode:'roast') have NO portal data — isolation from the client portal. */
  if (session.mode === 'roast') {
    return res.status(403).json({ error: 'This account has no portal access.' });
  }

  /* Master-only: read the portal-open log (which clients opened their audit, and
     when). Hangs off this endpoint via ?action=opens so it needs no extra Vercel
     function. `opens` is newest-first; `lastSeen` maps each id to its last open. */
  if (req.query && req.query.action === 'opens') {
    if (session.mode !== 'master') {
      return res.status(403).json({ error: 'Not allowed.' });
    }
    try {
      const raw = await redis.lrange('portal:opens', 0, 499);
      const opens = (raw || [])
        .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
        .filter(Boolean);
      const lastSeen = (await redis.hgetall('portal:lastopen')) || {};
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      return res.status(200).json({ success: true, opens, lastSeen });
    } catch (e) {
      console.error('[portal-data] opens read error:', e.message);
      return res.status(500).json({ error: 'Opens read failed' });
    }
  }

  /* Build the authorized slice based on the session role. */
  const empty = { partners: {}, directClients: {} };
  let slice = empty;

  if (session.mode === 'master') {
    slice = portalData;
  } else if (session.mode === 'partner' && session.partnerId && portalData.partners[session.partnerId]) {
    slice = {
      partners: { [session.partnerId]: portalData.partners[session.partnerId] },
      directClients: {}
    };
  } else if (session.mode === 'client') {
    /* Direct client: only their own entry under directClients. */
    if (session.clientId && portalData.directClients[session.clientId]) {
      slice = {
        partners: {},
        directClients: { [session.clientId]: portalData.directClients[session.clientId] }
      };
    } else if (session.partnerId && portalData.partners[session.partnerId]?.clients?.[session.clientId]) {
      /* Legacy: a client scoped under a partner — expose only that one client. */
      const p = portalData.partners[session.partnerId];
      slice = {
        partners: {
          [session.partnerId]: {
            name: p.name,
            description: p.description,
            clients: { [session.clientId]: p.clients[session.clientId] }
          }
        },
        directClients: {}
      };
    }
  }

  /* Log the open (who + when) so we can see which clients actually read their
     audit. Fire-and-forget: a logging failure must never break the portal. Master
     is the internal/admin view, so its own opens aren't logged. A short-lived
     per-id key dedupes refresh storms to at most one logged open per 10 minutes. */
  if (session.mode === 'partner' || session.mode === 'client') {
    try {
      const id = session.clientId || session.partnerId || 'unknown';
      const fresh = await redis.set('portal:open:recent:' + id, '1', { nx: true, ex: 600 });
      if (fresh) {
        let name = id;
        if (session.mode === 'client' && session.clientId && portalData.directClients[session.clientId]) {
          name = portalData.directClients[session.clientId].name || id;
        } else if (session.mode === 'client' && session.partnerId && portalData.partners[session.partnerId]?.clients?.[session.clientId]) {
          name = portalData.partners[session.partnerId].clients[session.clientId].name || id;
        } else if (session.mode === 'partner' && session.partnerId && portalData.partners[session.partnerId]) {
          name = portalData.partners[session.partnerId].name || id;
        }
        const at = new Date().toISOString();
        const entry = JSON.stringify({ at, mode: session.mode, id, name, email: session.email || null });
        await Promise.all([
          redis.lpush('portal:opens', entry),
          redis.ltrim('portal:opens', 0, 499),
          redis.hset('portal:lastopen', { [id]: at })
        ]);
      }
    } catch (e) {
      console.error('[portal-data] open-log error:', e.message);
    }
  }

  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  return res.status(200).json({ success: true, portalData: slice });
}
