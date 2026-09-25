import { Redis } from '@upstash/redis';

// Notion database: AdRoast V2 Internal
const NOTION_DATABASE_ID = 'ca2dbc99d48c4ca8ab59375cf76d62cb';

// Upstash Redis backs the booking-flow lead capture (null if not configured).
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

// Booking-flow constants + EmailJS (mirrors the client config).
const BI_PREFIX = 'bi:';
const BI_PENDING = 'bi:pending';
const FOLLOWUP_DELAY_MS = 1000 * 60 * 60 * 20; // nudge non-bookers ~20h after they filled the form
const RECORD_TTL = 60 * 60 * 24 * 30;          // keep lead records 30 days
const CALENDLY_URL = 'https://calendly.com/marina-kogan-adroast/30min';
const EMAILJS = {
  service_id: 'service_ywioabe',
  notify_template: 'template_gtqow85',                  // generic {{to_email}}/{{subject}}/{{message}} template
  public_key: '964Wa83HevoEa5KnS',
  private_key: process.env.EMAILJS_PRIVATE_KEY || null, // already set in Vercel (magic-link/welcome emails use it)
  notify_email: 'marina.kogan@adroast.in'
};

async function sendEmailJS(template_id, template_params) {
  if (!template_id) return false;
  const body = { service_id: EMAILJS.service_id, template_id, user_id: EMAILJS.public_key, template_params };
  if (EMAILJS.private_key) body.accessToken = EMAILJS.private_key;
  try {
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r.ok) console.error('[Lead API] EmailJS send failed:', r.status, await r.text().catch(() => ''));
    return r.ok;
  } catch (e) { console.error('[Lead API] EmailJS error:', e.message); return false; }
}


/* ---- Newsletter opt-in (Substack) ----------------------------------------
   The roast report form asks for an email to send the permanent link, and that
   screen promises "no spam, ever". So the weekly teardown needs its own, explicit
   consent: an unchecked box next to that field. When it is ticked we store the
   address here with the exact sentence the person agreed to, and a scheduled job
   adds those addresses to Substack from Marina's own session.
   Substack has no server-to-server subscribe: POST /api/v1/free answers 403 from a
   datacenter IP, which is why this is a queue and not a direct call. */
const NEWS_OPTIN_KEY = 'news:optin:';        // per-email record
const NEWS_OPTIN_PENDING = 'news:optin:pending';
const NEWS_CONSENT_TEXT = 'Also send me the weekly teardown: one real B2B ad and the landing page it sends to.';

async function storeNewsletterOptIn(email, source) {
  if (!redis || !email) return false;
  try {
    const rec = { email, ts: Date.now(), source: source || 'roast-report', consent: NEWS_CONSENT_TEXT };
    await redis.set(NEWS_OPTIN_KEY + email, rec);   // no TTL: it is the proof of consent
    await redis.sadd(NEWS_OPTIN_PENDING, email);
    return true;
  } catch (e) { console.error('[Lead API] newsletter opt-in store error:', e.message); return false; }
}

/* Admin-only read of the pending opt-ins, same key mechanism as /api/roast-view
   (roast:apikey:<key> -> email). Header only, never ?key= in the URL. */
async function isAdminKeyLead(req) {
  const authz = req.headers.authorization || '';
  const m = /^Bearer\s+(ak_[A-Za-z0-9_]+)/i.exec(authz);
  const key = (m && m[1]) || req.headers['x-api-key'] || '';
  if (!key || !/^ak_[A-Za-z0-9_]+$/.test(String(key)) || !redis) return false;
  try {
    const em = await redis.get(`roast:apikey:${key}`);
    return !!(em && String(em).toLowerCase() === 'marina.kogan@brandswithpurpose.us');
  } catch (e) { return false; }
}

// Generate short ID (8 chars)
const generateId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
};

export default async function handler(req, res) {
  // ---- Booking-flow lead capture (Redis) — handled before the Notion report path ----
  const action = req.method === 'GET' ? (req.query && req.query.action) : (req.body && req.body.action);

  // ---- Newsletter opt-ins: queue for the Substack import ----
  if (action === 'newsletter-optins') {
    if (!(await isAdminKeyLead(req))) return res.status(401).json({ error: 'unauthorized' });
    if (!redis) return res.status(200).json({ pending: [] });
    try {
      const emails = (await redis.smembers(NEWS_OPTIN_PENDING)) || [];
      const recs = [];
      for (const em of emails) {
        const r = await redis.get(NEWS_OPTIN_KEY + em);
        recs.push(r || { email: em });
      }
      return res.status(200).json({ pending: recs, count: recs.length });
    } catch (e) { return res.status(200).json({ pending: [], error: e.message }); }
  }

  if (action === 'newsletter-optins-done') {
    if (!(await isAdminKeyLead(req))) return res.status(401).json({ error: 'unauthorized' });
    const done = Array.isArray(req.body && req.body.emails) ? req.body.emails : [];
    if (!redis || !done.length) return res.status(200).json({ ok: true, removed: 0 });
    try {
      await redis.srem(NEWS_OPTIN_PENDING, ...done);
      return res.status(200).json({ ok: true, removed: done.length });
    } catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
  }

  if (action === 'book-intent' || action === 'book-mark') {
    if (!redis) return res.status(200).json({ ok: true, stored: false });
    // Leads are keyed by email (the auto-nudge channel); LinkedIn is stored alongside.
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const key = BI_PREFIX + email;
    try {
      if (action === 'book-intent') {
        const rec = { email, linkedin: (req.body.linkedin || '').trim(), ts: Date.now(), booked: false, followedUp: false };
        await redis.set(key, rec, { ex: RECORD_TTL });
        await redis.sadd(BI_PENDING, email);
      } else {
        const rec = (await redis.get(key)) || { email, linkedin: '', ts: Date.now(), followedUp: false };
        rec.booked = true;
        await redis.set(key, rec, { ex: RECORD_TTL });
        await redis.srem(BI_PENDING, email);
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[Lead API] booking store error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }

  if (action === 'followup-sweep') {
    if (!redis) return res.status(200).json({ ok: true, swept: 0 });
    try {
      const emails = (await redis.smembers(BI_PENDING)) || [];
      let emailed = 0, cleared = 0;
      for (const email of emails) {
        const rec = await redis.get(BI_PREFIX + email);
        if (!rec || rec.booked || rec.followedUp) { await redis.srem(BI_PENDING, email); cleared++; continue; }
        if (Date.now() - (rec.ts || 0) < FOLLOWUP_DELAY_MS) continue; // still in the grace window
        const hrs = Math.round((Date.now() - (rec.ts || 0)) / 3600000);
        // Auto-nudge the lead — same server-side EmailJS path magic-link/welcome emails use.
        const leadMsg = `Hey,\n\nYou started booking a call with us but didn't finish, no stress, life happens.\n\nIf you're putting real budget into ads and aren't sure they're converting the right buyer, that call is where we tell you straight what's working and what's leaking. About 20 minutes, no pitch.\n\nGrab a time whenever it suits: ${CALENDLY_URL}\n\nOr just reply to this email with your ad + landing page and I'll take a look.\n\nMarina\nAdRoast`;
        const sent = await sendEmailJS(EMAILJS.notify_template, {
          to_email: email,
          subject: 'You checked out the roast. Want the fix?',
          message: leadMsg
        });
        // Heads-up to Marina either way, with the LinkedIn for a direct reach-out.
        await sendEmailJS(EMAILJS.notify_template, {
          to_email: EMAILJS.notify_email,
          subject: `⏰ AdRoast: ${sent ? 'nudged' : 'COULD NOT nudge'} ${email} (form ${hrs}h ago, no booking)`,
          message: `${email} opened the calendar ~${hrs}h ago and hadn't booked, so we ${sent ? 'sent them a follow-up email' : 'FAILED to email them, follow up manually'}.\n\n🔗 LinkedIn: ${rec.linkedin || '-'}\n\nReach out on LinkedIn while it's warm.`
        });
        rec.followedUp = true;
        await redis.set(BI_PREFIX + email, rec, { ex: RECORD_TTL });
        await redis.srem(BI_PENDING, email);
        emailed++;
      }
      return res.status(200).json({ ok: true, emailed, cleared, pending: emails.length });
    } catch (e) {
      console.error('[Lead API] sweep error:', e.message);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) {
    console.error('NOTION_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const { platform, adScore, lpScore, matchScore, roastData, icp } = req.body;
    // Explicit, unticked-by-default consent from the roast report form.
    if (req.body && req.body.subscribeNewsletter) {
      const em = String(req.body.email || '').trim().toLowerCase();
      if (em && em.includes('@')) await storeNewsletterOptIn(em, 'roast-report');
    }
    
    const reportId = generateId();
    
    const platformMap = {
      'meta': 'Meta',
      'linkedin': 'LinkedIn', 
      'google': 'Google',
      'twitter': 'X/Twitter'
    };

    const properties = {
      'Lead': { title: [{ text: { content: `Report ${reportId}` } }] },
      'Report ID': { rich_text: [{ text: { content: reportId } }] },
      'Date': { date: { start: new Date().toISOString().split('T')[0] } }
    };

    if (platform && platformMap[platform]) properties['Platform'] = { select: { name: platformMap[platform] } };
    if (adScore && adScore !== 'N/A') properties['Ad Score'] = { number: parseFloat(adScore) };
    if (lpScore && lpScore !== 'N/A') properties['LP Score'] = { number: parseFloat(lpScore) };
    if (matchScore && matchScore !== 'N/A') properties['Match Score'] = { number: parseFloat(matchScore) };

    // Build content blocks
    const children = [];
    
    // JSON block for retrieval
    const roastJson = JSON.stringify({ result: roastData, icp, platform });
    const chunks = [];
    for (let i = 0; i < roastJson.length; i += 2000) {
      chunks.push(roastJson.substring(i, i + 2000));
    }
    chunks.forEach(chunk => {
      children.push({
        object: 'block',
        type: 'code',
        code: {
          rich_text: [{ type: 'text', text: { content: chunk } }],
          language: 'json'
        }
      });
    });

    // Divider
    children.push({ object: 'block', type: 'divider', divider: {} });

    // Readable summary
    if (roastData) {
      children.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: '🎯 Target Audience' } }] }
      });
      children.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: icp || 'Not specified' } }] }
      });

      children.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: '📊 Scores' } }] }
      });
      children.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `Ad Score: ${roastData.overall_score || 'N/A'}/10` } }] }
      });
      children.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `Landing Page: ${roastData.landing_page_roast?.overall_score || 'N/A'}/10` } }] }
      });
      children.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: `Ad-LP Match: ${roastData.ad_landing_mismatch?.alignment_score || 'N/A'}/10` } }] }
      });
    }

    console.log('[Lead API] Saving to Notion:', { reportId, blocks: children.length });

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: properties,
        children: children
      })
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('[Lead API] Notion error:', JSON.stringify(responseData));
      return res.status(500).json({ error: 'Failed to save', details: responseData });
    }

    console.log('[Lead API] Success:', reportId);
    return res.status(200).json({ success: true, reportId });
  } catch (error) {
    console.error('[Lead API] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
