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
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ORIGIN = 'https://www.adroast.in';
const PROTOCOL_VERSION = '2024-11-05';

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
    description: 'Roast a B2B ad against a buyer/ICP: scores the ad creative and its landing page, finds where it loses the click, and returns fixes. Provide the landing page URL and, ideally, the ad creative image URL and/or ad copy. If you pass a company website but no ICP, AdRoast infers the buyer from the site.',
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
      },
      required: ['landing_url'],
    },
  },
  {
    name: 'list_live_ads',
    description: "Pull a company's real live ads (LinkedIn + Google) and score each one against its buyer/ICP, worst first. Give the company website.",
    inputSchema: {
      type: 'object',
      properties: { website: { type: 'string', description: 'Company website, e.g. semgrep.dev (required).' } },
      required: ['website'],
    },
  },
  {
    name: 'get_report',
    description: 'Fetch a previously generated roast report by its id (the id in an adroast.in/?id=<id> link).',
    inputSchema: {
      type: 'object',
      properties: { report_id: { type: 'string', description: 'The report id (required).' } },
      required: ['report_id'],
    },
  },
];

async function detectSite(website, key) {
  const url = /^https?:\/\//i.test(website) ? website : 'https://' + website;
  const r = await fetch(`${ORIGIN}/api/icp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ url }) });
  const d = await r.json().catch(() => ({}));
  return { company: d.company || d.brand || '', domain: d.domain || '', icp: d.icp_text || '' };
}

async function callTool(name, args, key) {
  args = args || {};
  if (name === 'list_live_ads') {
    if (!args.website) throw new Error('website is required');
    const site = await detectSite(args.website, key);
    const r = await fetch(`${ORIGIN}/api/icp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ action: 'ads-fetch', company: site.company, domain: site.domain || args.website, icp: site.icp }) });
    const d = await r.json().catch(() => ({}));
    const ads = (d.ads || []).map(a => ({ platform: a.plat, headline: a.head || a.title || '', score: a.score, verdict: a.verdict || '', fix: a.fix || '', creative: a.img || null, detail_url: a.detailUrl || null }));
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
    if (!icp && args.website) { const site = await detectSite(args.website, key); icp = site.icp; company = company || site.company; }
    if (!icp) throw new Error('Provide an icp, or a website so the buyer can be inferred.');
    const payload = {
      platform: (args.platform || 'linkedin').toLowerCase(),
      icpDescription: icp,
      landingUrl: args.landing_url,
      adCopy: args.ad_copy || '',
      adImageUrl: args.ad_image_url || '',
      company,
      website: args.website || '',
      offerType: 'other',
    };
    const r = await fetch(`${ORIGIN}/api/roast`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(((d && d.error) || 'Roast failed') + (d && d._diag ? ' [' + d._diag + ']' : ''));
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
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-api-key, mcp-protocol-version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const key = keyFrom(req);
  const email = await emailForKey(key);

  // A browser GET (no JSON-RPC) returns a friendly status so pasting the URL confirms it works.
  if (req.method === 'GET') {
    return res.status(200).json({ server: 'AdRoast MCP', ok: !!email, authenticated: !!email, transport: 'streamable-http (JSON-RPC over POST)', tools: TOOLS.map(t => t.name) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
  // A JSON-RPC notification (no id) needs no response body.
  const isNotification = body && body.id === undefined && typeof body.method === 'string';
  const id = body ? body.id : null;
  const method = body ? body.method : '';

  try {
    if (method === 'initialize') {
      const pv = (body.params && body.params.protocolVersion) || PROTOCOL_VERSION;
      return res.status(200).json(rpcResult(id, { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'AdRoast', version: '1.0.0' } }));
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return res.status(202).end();
    }
    if (method === 'ping') return res.status(200).json(rpcResult(id, {}));
    if (method === 'tools/list') {
      return res.status(200).json(rpcResult(id, { tools: TOOLS }));
    }
    if (method === 'tools/call') {
      if (!email) return res.status(200).json(rpcError(id, -32001, 'Invalid or missing AdRoast API key. Add ?key=ak_... to the connector URL (get it in AdRoast -> My Account -> API & MCP).'));
      const name = body.params && body.params.name;
      const args = (body.params && body.params.arguments) || {};
      try {
        const out = await callTool(name, args, key);
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
