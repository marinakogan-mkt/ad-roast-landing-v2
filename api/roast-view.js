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

  /* Admin-only: the first-party VISITS dashboard (who entered and by which door). Rendered as a
     self-contained HTML page so it needs no React route: open /api/roast-view?action=visits while
     signed in as admin. Data is written by the /api/icp {action:'visit'} beacon. */
  if (req.query.action === 'visits') {
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!(await isAdmin(req))) {
      return res.status(401).send('<!doctype html><meta charset="utf-8"><body style="font:15px/1.5 system-ui;padding:48px;color:#0f1b2d;background:#eef3fa"><h2>Admin only</h2><p>Sign in with your AdRoast admin account, then reload this page.</p></body>');
    }
    // Opening the dashboard means this is the admin's browser, so stamp it so its own future
    // visits (even logged out) are never logged. The visit beacon in /api/icp checks this cookie.
    res.setHeader('Set-Cookie', 'ar_notrack=1; Path=/; Max-Age=31536000; SameSite=Lax');
    let items = [];
    try {
      const raw = await redis.lrange('visits:log', 0, 2000);
      items = (raw || []).map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } }).filter(Boolean);
      // Drop the admin's own entries already in the log (belt and suspenders for rows written
      // before self-exclusion shipped), so the numbers reflect real visitors only.
      items = items.filter(v => !(v && v.email && ADMIN_EMAILS.has(String(v.email).toLowerCase())));
    } catch (e) {}
    const byEntry = {}, bySource = {}, byCompany = {};
    for (const v of items) {
      byEntry[v.entry || 'other'] = (byEntry[v.entry || 'other'] || 0) + 1;
      const src = (v.utm && v.utm.source) || v.refHost || 'direct';
      bySource[src] = (bySource[src] || 0) + 1;
      if (v.slug) byCompany[v.slug] = (byCompany[v.slug] || 0) + 1;
    }
    const topN = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
    const fmt = (ts) => { try { return new Date(ts).toISOString().slice(0, 16).replace('T', ' '); } catch (e) { return ''; } };
    const tile = (label, val) => `<div style="background:#fff;border:1px solid #e6ebf2;border-radius:14px;padding:14px 18px;min-width:130px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b">${esc(label)}</div><div style="font-size:26px;font-weight:800;color:#0f1b2d;margin-top:2px">${esc(val)}</div></div>`;
    const chipList = (title, entries) => `<div style="background:#fff;border:1px solid #e6ebf2;border-radius:14px;padding:14px 18px;flex:1;min-width:240px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:8px">${esc(title)}</div>${entries.length ? entries.map(([k, n]) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:3px 0;color:#0f1b2d"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k)}</span><b>${n}</b></div>`).join('') : '<div style="font-size:13px;color:#94a3b8">No data yet</div>'}</div>`;
    const rows = items.slice(0, 500).map(v => {
      const src = (v.utm && v.utm.source) || v.refHost || 'direct';
      const camp = (v.utm && v.utm.campaign) ? ' / ' + v.utm.campaign : '';
      const geo = [v.geo && v.geo.city, v.geo && v.geo.country].filter(Boolean).join(', ');
      const link = v.slug ? esc(v.slug) : '';
      // The exact link the visitor landed on (path + query, e.g. /b/strivacity?utm_source=li),
      // as a clickable adroast.in URL so you can open the very page they clicked.
      const path = v.path ? (String(v.path).charAt(0) === '/' ? v.path : '/' + v.path) : '';
      const landing = path ? `<a href="https://www.adroast.in${esc(path)}" target="_blank" rel="noopener" style="color:#0a66c2;text-decoration:none">${esc(path)}</a>` : '';
      return `<tr>
        <td style="white-space:nowrap;color:#64748b">${esc(fmt(v.ts))}</td>
        <td><span class="e e-${esc(v.entry || 'other')}">${esc(v.entry || 'other')}</span></td>
        <td>${link}</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${landing}</td>
        <td>${esc(src)}${esc(camp)}</td>
        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.ref)}">${esc(v.ref || '')}</td>
        <td>${esc(geo)}</td>
        <td>${esc(v.dev || '')}${v.ret ? ' · ret' : ''}</td>
        <td>${esc(v.email || '')}</td>
      </tr>`;
    }).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AdRoast visits</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#eef3fa;color:#0f1b2d}
  .wrap{max-width:1200px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:22px;margin:0 0 4px}.sub{color:#64748b;font-size:13px;margin-bottom:20px}
  .tiles{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .cols{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e6ebf2;border-radius:14px;overflow:hidden}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;text-align:left;padding:10px 12px;border-bottom:1px solid #eef1f5;background:#f8fafc}
  td{padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  .e{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .e-board{background:#dcfce7;color:#15803d}.e-report{background:#e0f2fe;color:#0369a1}.e-home{background:#f1f5f9;color:#475569}.e-other{background:#fef3c7;color:#92400e}
</style></head><body><div class="wrap">
  <h1>AdRoast visits</h1><div class="sub">First-party. Last ${items.length} visits (capped at 10k), your own excluded. Newest first.</div>
  <div class="tiles">${tile('Total', items.length)}${tile('Homepage', byEntry.home || 0)}${tile('Board links', byEntry.board || 0)}${tile('Roast links', byEntry.report || 0)}</div>
  <div class="cols">${chipList('Top sources', topN(bySource, 8))}${chipList('Top company links', topN(byCompany, 8))}</div>
  <input id="q" placeholder="Filter (company, source, referrer, email, geo)..." oninput="filt()">
  <table id="t"><thead><tr><th>When (UTC)</th><th>Entry</th><th>Company / link</th><th>Link clicked</th><th>Source</th><th>Referrer</th><th>Geo</th><th>Device</th><th>Email</th></tr></thead><tbody>${rows || '<tr><td colspan="9" style="color:#94a3b8;padding:20px">No visits recorded yet.</td></tr>'}</tbody></table>
</div>
<script>function filt(){var q=document.getElementById('q').value.toLowerCase();var rows=document.querySelectorAll('#t tbody tr');rows.forEach(function(r){r.style.display=r.textContent.toLowerCase().indexOf(q)>-1?'':'none';});}</script>
</body></html>`;
    return res.status(200).send(html);
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing report ID' });
  }

  /* Serve a report's ad creative as a raw image (base64 stored inline -> decoded bytes; or a
     redirect to the hotlink). Lets the "My roasted ads" dashboard show the real creative without
     inlining heavy base64 into the roast list. Public, like the shareable report itself. */
  if (req.query.action === 'creative') {
    try {
      const raw = await redis.get(`roast:report:${id}`);
      const rec = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (rec && rec.adScreenshot) {
        const b64 = String(rec.adScreenshot).replace(/^data:[^,]+,/, '');
        const buf = Buffer.from(b64, 'base64');
        res.setHeader('Content-Type', rec.adScreenshotType || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(200).send(buf);
      }
      // Larger creatives are stored in their own key (permanent, never expires like a hotlink).
      if (rec && rec.adCreativeKey) {
        const craw = await redis.get(`roast:creative:${id}`);
        const c = craw ? (typeof craw === 'string' ? JSON.parse(craw) : craw) : null;
        if (c && c.b64) {
          const buf = Buffer.from(String(c.b64).replace(/^data:[^,]+,/, ''), 'base64');
          res.setHeader('Content-Type', c.type || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.status(200).send(buf);
        }
      }
      if (rec && rec.adImageUrl && /^https?:\/\//i.test(rec.adImageUrl)) {
        // Proxy the hotlink server-side (licdn/googlesyndication block cross-site hotlinking, so a
        // 302 to them renders blank); fetch it here and stream the bytes back. Two attempts: a plain
        // fetch, then a retry with a LinkedIn Referer (some licdn assets 403 a naked fetch).
        const _hdrs = [
          { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', 'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8' },
          { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', 'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8', 'Referer': 'https://www.linkedin.com/', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Site': 'cross-site' }
        ];
        for (let _a = 0; _a < _hdrs.length; _a++) {
          try {
            const r = await fetch(rec.adImageUrl, { headers: _hdrs[_a] });
            if (r.ok) {
              const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length > 0) {
                res.setHeader('Content-Type', ct.startsWith('image/') ? ct : 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.status(200).send(buf);
              }
            }
          } catch (e) { /* try next / fall through to 404 */ }
        }
      }
      return res.status(404).end();
    } catch (e) { return res.status(404).end(); }
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
