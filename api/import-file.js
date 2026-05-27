/**
 * POST /api/import-file
 *
 * Fetches a publicly accessible Google Sheets / Drive file (or any public URL)
 * and returns CSV text the frontend can parse into audit variants.
 *
 * Body: { url: "https://docs.google.com/spreadsheets/d/.../edit?gid=..." }
 *
 * Response shapes:
 *   200 { success: true, format: 'csv', text: '<csv contents>', source: '<final URL fetched>' }
 *   400 { error: '<human readable>' }   // bad input or fetch denied
 *   500 { error: '<server error>' }
 *
 * Google Sheets URL handling:
 *   - /spreadsheets/d/<ID>/edit                       -> /export?format=csv
 *   - /spreadsheets/d/<ID>/edit?gid=N#gid=N            -> /export?format=csv&gid=N
 *   - /spreadsheets/d/<ID>/edit?usp=sharing            -> /export?format=csv
 *
 * Google Drive URL handling:
 *   - /file/d/<ID>/view                                -> /uc?export=download&id=<ID>
 *
 * If the server returns 401 / 403 we surface a clear "make the link public"
 * message back to the user.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const raw = (body.url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(raw)) {
    return res.status(400).json({ error: 'Paste a valid http(s) link.' });
  }

  // Resolve to a fetchable URL. Default = original URL.
  let target = raw;
  let kind = 'generic';

  // Google Sheets
  const sheetsMatch = raw.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (sheetsMatch) {
    const id = sheetsMatch[1];
    let gid = null;
    const gidMatch = raw.match(/[?&#]gid=(\d+)/);
    if (gidMatch) gid = gidMatch[1];
    target = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv` + (gid ? `&gid=${gid}` : '');
    kind = 'gsheet';
  } else {
    // Google Drive file
    const driveMatch = raw.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (driveMatch) {
      target = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
      kind = 'gdrive';
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/csv,text/plain,*/*'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (r.status === 401 || r.status === 403) {
      return res.status(400).json({
        error: 'Please make sure the link is public before pasting it. (The server got a ' + r.status + ' from this URL.)',
        kind,
        target
      });
    }
    if (!r.ok) {
      return res.status(400).json({
        error: 'Could not fetch the file (HTTP ' + r.status + '). If this is a Google Sheets / Drive link, make sure sharing is set to "Anyone with the link" before retrying.',
        kind,
        target
      });
    }

    const contentType = (r.headers.get('content-type') || '').toLowerCase();
    const finalUrl = r.url || target;

    // Google Sheets returns HTML when the doc isn't public (a login page).
    // Detect that and return the friendly "make it public" message.
    if (kind === 'gsheet' && contentType.includes('text/html')) {
      return res.status(400).json({
        error: 'Please make sure the link is public before pasting it. (Google served a login page instead of CSV — the sheet sharing is probably restricted.)',
        kind,
        target: finalUrl
      });
    }

    const text = await r.text();
    if (!text || text.length < 5) {
      return res.status(400).json({
        error: 'The file was reachable but empty.',
        kind,
        target: finalUrl
      });
    }

    return res.status(200).json({
      success: true,
      format: kind === 'gsheet' ? 'csv' : (contentType.includes('csv') ? 'csv' : 'text'),
      text,
      source: finalUrl
    });
  } catch (e) {
    return res.status(500).json({ error: 'Fetch failed: ' + e.message });
  }
}
