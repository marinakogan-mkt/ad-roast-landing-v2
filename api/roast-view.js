// Fetch roast data by Report ID, or (admin) list the most recent roasts.
//
// Storage: new roasts are persisted to Redis by /api/roast under
//   roast:report:<id>  — the full report record
//   roast:index        — a capped list of compact summaries (newest first)
// so the internal roasts list needs NO Notion. Older reports (saved via the
// "Save Your Report" / LinkedIn flow) still live in Notion, so id lookups fall
// back to Notion on a Redis miss.
import { Redis } from '@upstash/redis';
import { isPrivateReport, readSessionCookie, PORTAL_ROLES } from './auth/_allowlist.js';

const NOTION_DATABASE_ID = 'ca2dbc99d48c4ca8ab59375cf76d62cb';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// Admins allowed to list all roasts = the portal master role's emails.
const ADMIN_EMAILS = new Set(
  ((PORTAL_ROLES.find(r => r.mode === 'master') || {}).emails || []).map(e => e.toLowerCase())
);

/* Raw session for the cookie, regardless of mode ('roast' or portal). */
async function getSession(req) {
  const token = readSessionCookie(req);
  if (!token) return null;
  try {
    const raw = await redis.get(`auth:session:${token}`);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (e) {
    return null;
  }
}

/* A valid PORTAL session (roast-tool accounts don't count) — used to gate
   portal-private audits, matching the prior behavior. */
async function lookupPortalSession(req) {
  const s = await getSession(req);
  if (s && s.mode === 'roast') return null;
  return s;
}

async function isAdmin(req) {
  const s = await getSession(req);
  return !!(s && s.email && ADMIN_EMAILS.has(String(s.email).toLowerCase()));
}

/* Backfill older roasts that live only in Notion (saved via the pre-Redis
   "Save Your Report" / LinkedIn flow) so they show in the internal list too.
   Reads only page PROPERTIES (Report ID, Platform, scores, Date) — no per-page
   block fetch — so it's a couple of queries, not one-per-roast. */
async function fetchNotionRoastSummaries(maxPages = 3) {
  const key = process.env.NOTION_API_KEY;
  if (!key) return [];
  const out = [];
  let cursor = undefined;
  for (let page = 0; page < maxPages; page++) {
    const body = { sorts: [{ property: 'Date', direction: 'descending' }], page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify(body)
    });
    if (!r.ok) break;
    const data = await r.json();
    for (const pg of (data.results || [])) {
      const p = pg.properties || {};
      const reportId = p['Report ID']?.rich_text?.[0]?.plain_text || '';
      if (!reportId) continue;
      const dateStr = p['Date']?.date?.start || '';
      out.push({
        reportId,
        ts: dateStr ? (Date.parse(dateStr) || 0) : 0,
        email: '',
        platform: (p['Platform']?.select?.name || '').toLowerCase(),
        company: '',
        icp: '',
        adScore: (typeof p['Ad Score']?.number === 'number') ? p['Ad Score'].number : null,
        lpScore: (typeof p['LP Score']?.number === 'number') ? p['LP Score'].number : null,
        matchScore: (typeof p['Match Score']?.number === 'number') ? p['Match Score'].number : null,
        source: 'notion'
      });
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  /* Admin-only: list the most recent roasts from the Redis index. */
  if (req.query.action === 'list') {
    if (!(await isAdmin(req))) {
      return res.status(401).json({ error: 'Admin only' });
    }
    try {
      const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);
      const raw = await redis.lrange('roast:index', 0, 999);
      const redisItems = (raw || [])
        .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } })
        .filter(Boolean)
        .map(x => ({ ...x, source: x.source || 'redis' }));
      // Merge in older Notion-only roasts (best-effort — a Notion outage still returns Redis).
      let notionItems = [];
      try { notionItems = await fetchNotionRoastSummaries(); }
      catch (e) { console.error('[Roast View] notion backfill error:', e.message); }
      // Dedupe by reportId, preferring the richer Redis record.
      const seen = new Set();
      const merged = [];
      for (const it of [...redisItems, ...notionItems]) {
        if (!it || !it.reportId || seen.has(it.reportId)) continue;
        seen.add(it.reportId);
        merged.push(it);
      }
      merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const items = merged.slice(0, limit);
      return res.status(200).json({ items, count: items.length });
    } catch (e) {
      console.error('[Roast View] list error:', e.message);
      return res.status(500).json({ error: 'Failed to list roasts' });
    }
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing report ID' });
  }

  /* Redis-first: internal roasts stored by /api/roast. Returns without ever
     touching Notion, so the report link works even if Notion is down/unset. */
  try {
    const raw = await redis.get(`roast:report:${id}`);
    const rec = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    if (rec && rec.result) {
      return res.status(200).json({
        result: rec.result,
        icp: rec.icp || '',
        platform: rec.platform || 'meta',
        company: rec.company || '',
        website: rec.website || '',
        landingUrl: rec.landingUrl || '',
        adUrl: rec.adUrl || '',
        adCopy: rec.adCopy || '',
        visualDescription: rec.visualDescription || '',
        offerType: rec.offerType || '',
        offerDetail: rec.offerDetail || '',
        adScreenshot: rec.adScreenshot || '',
        adScreenshotType: rec.adScreenshotType || ''
      });
    }
  } catch (e) {
    /* Redis miss/outage — fall through to the Notion lookup below. */
  }

  /* Portal-private reports require a valid portal session. Public roasts still
     flow through as before. The 401 includes `private: true` so the frontend can
     show a "Sign in to view" gate instead of a generic error. */
  if (isPrivateReport(id)) {
    const session = await lookupPortalSession(req);
    if (!session) {
      return res.status(401).json({
        error: 'This audit is private. Sign in to view it.',
        private: true,
        signInUrl: '/#portal'
      });
    }
  }

  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) {
    return res.status(404).json({ error: 'Report not found' });
  }

  try {
    // Query Notion database for the report ID
    const queryResponse = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        filter: {
          property: 'Report ID',
          rich_text: { equals: id }
        }
      })
    });

    if (!queryResponse.ok) {
      const error = await queryResponse.json();
      console.error('[Roast View] Query error:', error);
      return res.status(500).json({ error: 'Database query failed' });
    }

    const queryData = await queryResponse.json();

    if (!queryData.results || queryData.results.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const pageId = queryData.results[0].id;

    // Fetch page blocks (content)
    const blocksResponse = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28'
      }
    });

    if (!blocksResponse.ok) {
      console.error('[Roast View] Blocks fetch error');
      return res.status(500).json({ error: 'Failed to fetch report data' });
    }

    const blocksData = await blocksResponse.json();

    // Combine all code blocks to reconstruct the JSON
    let roastJson = '';
    for (const block of blocksData.results) {
      if (block.type === 'code' && block.code?.rich_text) {
        for (const text of block.code.rich_text) {
          roastJson += text.plain_text || '';
        }
      }
    }

    if (!roastJson) {
      return res.status(404).json({ error: 'Roast data not found' });
    }

    const roastData = JSON.parse(roastJson);
    return res.status(200).json(roastData);

  } catch (error) {
    console.error('[Roast View] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
