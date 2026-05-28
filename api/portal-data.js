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

  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  return res.status(200).json({ success: true, portalData: slice });
}
