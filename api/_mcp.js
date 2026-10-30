// AdRoast MCP server (Streamable HTTP, JSON-RPC 2.0). Lets Claude (desktop or cloud) act as a
// roast account and use AdRoast for outreach WITHOUT a browser: roast an ad, pull a company's
// live-ads board, fetch a saved report. Authenticated by a personal API key (issued in My Account
// -> API & MCP): pass it as ?key=ak_... in the connector URL, or Authorization: Bearer / x-api-key.
//
// Underscore prefix => NOT its own Vercel function (the Hobby 12-function cap is already full).
// It is exposed at the clean path /api/mcp via a vercel.json rewrite to /api/icp?mcp=1, and
// api/icp.js delegates any mcp=1 request to mcpHandler() below. It calls the existing /api/roast
// and /api/icp over our own origin, forwarding the key so a roast counts against the account's
// tokens exactly like an in-app roast.
import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { emailForAccessToken, PRM_URL } from './_oauth.js';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ORIGIN = 'https://www.adroast.in';
const PROTOCOL_VERSION = '2024-11-05';

// OAuth (Claude Connectors Directory): Authorization: Bearer at_... issued by api/_oauth.js.
function oauthTokenFrom(req) {
  const authz = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(at_[a-f0-9]+)/i.exec(authz);
  return m ? m[1] : '';
}
// An OAuth user may never have opened My Account, so issue their API key on first use. Same
// keys and format as getOrCreateApiKey in api/auth.js; /api/roast only understands ak_ keys.
async function apiKeyForEmail(email) {
  const fwd = `roast:apikeyfor:${email}`;
  const have = await redis.get(fwd);
  if (have) return String(have);
  const key = 'ak_live_' + crypto.randomBytes(24).toString('hex');
  await redis.set(fwd, key);
  await redis.set(`roast:apikey:${key}`, email);
  return key;
}

function keyFrom(req) {
  const authz = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(ak_[A-Za-z0-9_]+)/i.exec(authz);
  return (m && m[1]) || req.headers['x-api-key'] || (req.query && req.query.key) || '';
}
async function emailForKey(key) {
  if (!key || !/^ak_[A-Za-z0-9_]+$/.test(String(key))) return null;
  try { const em = await redis.get(`roast:apikey:${key}`); return em ? String(em).toLowerCase() : null; }
  catch (e) { return null; }
}

const TOOLS = [
  {
    name: 'roast_ad',
    title: 'Roast an ad',
    annotations: { title: 'Roast an ad', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Roast a B2B ad against a buyer/ICP: scores the ad creative and its landing page, finds where it loses the click, and returns fixes. Provide the landing page URL and, ideally, the ad creative image URL and/or ad copy. If you pass a company website but no ICP, AdRoast infers the buyer from the site. Each call uses one roast from the account plan and saves a report.',
    inputSchema: {
      type: 'object',
      properties: {
        landing_url: { type: 'string', description: 'The page the ad sends people to (required).' },
        ad_image_url: { type: 'string', description: 'Public URL of the ad creative image (optional but recommended).' },
        ad_copy: { type: 'string', description: 'The ad text/copy, if you have it (optional).' },
        icp: { type: 'string', description: 'Who the ad should target, e.g. "Heads of AppSec at Series B+ SaaS" (optional if website is given).' },
        website: { type: 'string', description: 'Company website, used to infer the ICP when icp is not given (optional).' },
        platform: { type: 'string', description: 'linkedin | google | meta (optional, default linkedin).' },
        company: { type: 'string', description: 'Company/advertiser name (optional).' },
        ad_url: { type: 'string', description: 'The ad-library detail URL of the ad (e.g. https://www.linkedin.com/ad-library/detail/NNN). For a VIDEO ad, pass this so AdRoast fetches and analyzes the clip frame-by-frame instead of judging only its still thumbnail.' },
      },
      required: ['landing_url'],
    },
  },
  {
    name: 'list_live_ads',
    title: "List a company's live ads",
    annotations: { title: "List a company's live ads", readOnlyHint: true, openWorldHint: true },
    description: "Pull a company's real live ads (LinkedIn + Google) and score each one against its buyer/ICP, worst first. Give the company website.",
    inputSchema: {
      type: 'object',
      properties: { website: { type: 'string', description: 'Company website, e.g. semgrep.dev (required).' } },
      required: ['website'],
    },
  },
  {
    name: 'get_report',
    title: 'Get a roast report',
    annotations: { title: 'Get a roast report', readOnlyHint: true, openWorldHint: false },
    description: 'Fetch a previously generated roast report by its id (the id in an adroast.in/?id=<id> link).',
    inputSchema: {
      type: 'object',
      properties: { report_id: { type: 'string', description: 'The report id (required).' } },
      required: ['report_id'],
    },
  },
];

async function detectSite(website, key, asHdr) {
  const url = /^https?:\/\//i.test(website) ? website : 'https://' + website;
  const r = await fetch(`${ORIGIN}/api/icp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, ...(asHdr ? { 'x-adroast-as': asHdr } : {}) }, body: JSON.stringify({ url }) });
  const d = await r.json().catch(() => ({}));
  return { company: d.company || d.brand || '', domain: d.domain || '', icp: d.icp_text || '' };
}

async function callTool(name, args, key, asHdr) {
  args = args || {};
  if (name === 'list_live_ads') {
    if (!args.website) throw new Error('website is required');
    const site = await detectSite(args.website, key, asHdr);
    const r = await fetch(`${ORIGIN}/api/icp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, ...(asHdr ? { 'x-adroast-as': asHdr } : {}) }, body: JSON.stringify({ action: 'ads-fetch', company: site.company, domain: site.domain || args.website, icp: site.icp }) });
    const d = await r.json().catch(() => ({}));
    // Never surface a wrong-advertiser / homonym ad (a conveyor-belt maker under "Conveyor" the SaaS,
    // a trademark-filing firm under "Clutch"). icp.js already drops these, but filter here too so an
    // older contaminated board cache can never leak one through the MCP.
    const ads = (d.ads || [])
      .filter(a => a.flag !== 'capture_fail' && !a._captureFail)
      .map(a => ({ platform: a.plat, headline: a.head || a.title || '', score: a.score, verdict: a.verdict || '', fix: a.fix || '', creative: a.img || null, detail_url: a.detailUrl || null }));
    return { company: site.company || args.website, buyer: site.icp || null, count: ads.length, ads };
  }
  if (name === 'get_report') {
    if (!args.report_id) throw new Error('report_id is required');
    const r = await fetch(`${ORIGIN}/api/roast-view?id=${encodeURIComponent(args.report_id)}`);
    if (!r.ok) throw new Error('Report not found');
    const d = await r.json().catch(() => ({}));
    return { report_id: args.report_id, link: `${ORIGIN}/?id=${args.report_id}`, ...d };
  }
  if (name === 'roast_ad') {
    if (!args.landing_url) throw new Error('landing_url is required');
    let icp = (args.icp || '').trim();
    let company = args.company || '';
    if (!icp && args.website) { const site = await detectSite(args.website, key, asHdr); icp = site.icp; company = company || site.company; }
    if (!icp) throw new Error('Provide an icp, or a website so the buyer can be inferred.');
    // A LinkedIn video ad only exposes a still "videocover" thumbnail. Flag it as video so api/roast
    // analyzes the clip (a 6-frame storyboard, when ad_url points at the ad-library detail page) or
    // honestly skips the visual, instead of judging the cover frame and calling it a static logo.
    const adUrl = (args.ad_url || '').trim();
    const isVideo = /videocover/i.test(args.ad_image_url || '') || /\/ad-library\/detail\/\d+/.test(adUrl);
    const payload = {
      platform: (args.platform || 'linkedin').toLowerCase(),
      icpDescription: icp,
      landingUrl: args.landing_url,
      adCopy: args.ad_copy || '',
      adImageUrl: args.ad_image_url || '',
      adUrl,
      isVideo,
      company,
      website: args.website || '',
      offerType: 'other',
    };
    const r = await fetch(`${ORIGIN}/api/roast`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, ...(asHdr ? { 'x-adroast-as': asHdr } : {}) }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) || 'Roast failed');
    // The landing and ICP gates in api/roast.js answer 200 with needsLanding /
    // needsIcp instead of a roast: there was no page to read, or no buyer we could
    // detect. Surface that as an ASK. Falling through returned an empty roast
    // (null score, no issues) that read like a result, and the caller's next move
    // was to roast the homepage instead, which judges a page the ad never used.
    if (d && d.needsLanding) {
      return { needs_input: 'landing_page', landing_status: d.landingStatus || 'missing',
               landing_url: d.landingUrl || args.landing_url || '',
               message: d.landingStatus === 'unreadable'
                 ? "The landing page was given but could not be read (bot-blocked or JS-rendered). Pass a reachable landing_url, or paste its copy. Do NOT substitute the homepage: it is not necessarily the page this ad pointed at."
                 : "No landing page for this ad. Ask the user for the ad's landing_url. Do NOT substitute the homepage." };
    }
    if (d && d.needsIcp) {
      return { needs_input: 'icp', icp_reason: d.icpReason || 'missing',
               website: d.website || args.website || '',
               message: "The buyer could not be detected from the site, so the ad has nothing to be scored against. Ask the user who this sells to and pass it as icp. Do NOT guess." };
    }
    const ent = d._entitlement || {};
    if (ent.full === false) return { locked: true, message: "This roast is gated because the account is out of free roasts. Top up at adroast.in or roast the account's worst ad free from the board.", overall_score: d.overall_score ?? null };
    return {
      report_id: d._reportId || null,
      link: d._reportId ? `${ORIGIN}/?id=${d._reportId}` : null,
      overall_score: d.overall_score ?? null,
      icp_mismatch: d.icp_mismatch || '',
      issues: (d.issues || []).map(i => ({ title: i.title, score: i.score, explanation: i.explanation })),
      landing_page_score: d.landing_page_roast?.overall_score ?? null,
      recommendation: d.recommendation || d.verdict || '',
    };
  }
  throw new Error('Unknown tool: ' + name);
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

export async function mcpHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, mcp-protocol-version, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let key = keyFrom(req);
  let email = await emailForKey(key);
  const at = oauthTokenFrom(req);
  if (!email && at) {
    email = await emailForAccessToken(at);
    if (email) key = await apiKeyForEmail(email);
  }
  // No valid credential: 401 + resource_metadata starts Claude's OAuth sign-in. A bad/expired
  // bearer token gets the same answer so Claude refreshes it.
  const unauthorized = () => {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${PRM_URL}", scope="roast"`);
    return res.status(401).json({ error: 'unauthorized', error_description: 'Sign in to AdRoast (OAuth) or pass an AdRoast API key.' });
  };

  // A browser GET (no JSON-RPC) returns a friendly status so pasting the URL confirms it works.
  if (req.method === 'GET') {
    return res.status(200).json({ server: 'AdRoast MCP', ok: !!email, authenticated: !!email, transport: 'streamable-http (JSON-RPC over POST)', tools: TOOLS.map(t => t.name) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!email) return unauthorized();

  const body = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
  // A JSON-RPC notification (no id) needs no response body.
  const isNotification = body && body.id === undefined && typeof body.method === 'string';
  const id = body ? body.id : null;
  const method = body ? body.method : '';

  try {
    if (method === 'initialize') {
      const pv = (body.params && body.params.protocolVersion) || PROTOCOL_VERSION;
      return res.status(200).json(rpcResult(id, { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'AdRoast', title: 'AdRoast', version: '1.1.0' } }));
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return res.status(202).end();
    }
    if (method === 'ping') return res.status(200).json(rpcResult(id, {}));
    if (method === 'tools/list') {
      return res.status(200).json(rpcResult(id, { tools: TOOLS }));
    }
    if (method === 'tools/call') {
      const name = body.params && body.params.name;
      const args = (body.params && body.params.arguments) || {};
      try {
        const out = await callTool(name, args, key, String(req.headers['x-adroast-as'] || '').toLowerCase() === 'apify' ? 'apify' : '');
        return res.status(200).json(rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }));
      } catch (e) {
        return res.status(200).json(rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + (e && e.message || e) }], isError: true }));
      }
    }
    if (isNotification) return res.status(202).end();
    return res.status(200).json(rpcError(id, -32601, 'Method not found: ' + method));
  } catch (e) {
    console.error('[mcp] error:', e && e.message);
    return res.status(200).json(rpcError(id, -32603, 'Internal error'));
  }
}
