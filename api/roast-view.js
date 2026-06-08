// Fetch roast data by Report ID
import { Redis } from '@upstash/redis';
import { isPrivateReport, readSessionCookie } from './auth/_allowlist.js';

const NOTION_DATABASE_ID = 'ca2dbc99d48c4ca8ab59375cf76d62cb';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

/* Confirm the session cookie maps to a real, unexpired portal session.
   Returns the session payload or null. */
async function lookupSession(req) {
  const token = readSessionCookie(req);
  if (!token) return null;
  try {
    const raw = await redis.get(`auth:session:${token}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing report ID' });
  }

  /* Portal-private reports require a valid session. Public roasts still flow through
     as before. The 401 response includes `private: true` so the frontend can show
     a "Sign in to view" gate instead of a generic error. */
  if (isPrivateReport(id)) {
    const session = await lookupSession(req);
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
    return res.status(500).json({ error: 'Server configuration error' });
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
