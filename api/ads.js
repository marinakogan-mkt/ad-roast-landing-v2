// api/ads.js — pull a company's REAL live ads (with creative images) for the "Your Live
// Ads" dashboard, via the Apify LinkedIn Ad Library actor. LinkedIn's official API returns
// no creative image, and its ad-library pages block server reads (Cloudflare 403), so we
// use Apify (residential rendering) which returns mediaUrl = the real creative.
//
// Actor: automation-lab/linkedin-ad-library-scraper  (pay-per-event, ~$0.001/ad, no rental)
// Output per ad: advertiserName, advertiserLinkedInUrl, headline, bodyText, ctaLabel,
//   ctaUrl, mediaUrl, adFormat, adId, fundingEntityName, detailUrl.
//
// Env: APIFY_TOKEN (Marina adds it in Vercel; found under Apify Console > Integrations).
//
// Flow (async so we never hold a serverless request open through a scrape):
//   POST { action:'start', company | advertiserUrl, country } -> { runId, datasetId }
//   POST { action:'poll', runId, icp } -> while running { status, ads:null };
//     on SUCCEEDED { status, ads:[...] } (scored against icp if provided).

export const config = { maxDuration: 60 };

const ACTOR = 'automation-lab~linkedin-ad-library-scraper';
const APIFY = 'https://api.apify.com/v2';
const SCORE_MODEL = process.env.ANTHROPIC_ICP_MODEL || 'claude-haiku-4-5';

function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return null; } }

function normalize(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const head = rec.headline || rec.bodyText || rec.title || '';
  const img = rec.mediaUrl || rec.imageUrl || rec.thumbnailUrl || null;
  if (!head && !img) return null;
  return {
    plat: 'LinkedIn',
    head: head,
    body: rec.bodyText || '',
    img: img,
    cta: rec.ctaLabel || null,
    ctaUrl: rec.ctaUrl || null,
    dom: rec.ctaUrl ? host(rec.ctaUrl) : (rec.advertiserLinkedInUrl ? 'linkedin.com' : null),
    advertiser: rec.advertiserName || null,
    advertiserUrl: rec.advertiserLinkedInUrl || null,
    adId: rec.adId || null,
    detailUrl: rec.detailUrl || null,
    format: rec.adFormat || null,
  };
}

// Quick gravity pass: score every ad 1-10 for how well it fits the ICP and drives the
// click, plus a one-line verdict, and a fix for the weakest. One cheap Haiku call for the
// whole set. Best-effort: any failure just returns the ads unscored.
async function scoreAds(ads, icp) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !icp || !ads.length) return ads;
  const list = ads.map((a, i) => `#${i}: headline="${(a.head || '').slice(0, 140)}" body="${(a.body || '').slice(0, 200)}" cta="${a.cta || ''}"`).join('\n');
  const sys = `You are a B2B ad auditor. Score each ad 1-10 for how well it fits the target ICP and earns the click (1 = severe mismatch, 10 = excellent). Return ONLY a JSON array, one object per ad index, shape: {"i":0,"score":5,"verdict":"one short line","fix":"one short fix line"}. No markdown. Never use em dashes or en dashes; use commas or periods.`;
  const usr = `ICP: ${icp}\n\nAds:\n${list}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: SCORE_MODEL, max_tokens: 1500, system: sys, messages: [{ role: 'user', content: usr }] }),
    });
    const d = await r.json();
    const txt = d.content?.[0]?.text || '';
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return ads;
    const scores = JSON.parse(m[0]);
    const byI = {};
    for (const s of scores) if (typeof s.i === 'number') byI[s.i] = s;
    return ads.map((a, i) => byI[i] ? { ...a, score: byI[i].score, verdict: byI[i].verdict, fix: byI[i].fix } : a);
  } catch (e) { return ads; }
}

async function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  return body;
}

export default async function handler(req, res) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return res.status(200).json({ ok: false, reason: 'no_token', ads: [] });

  const body = await readBody(req);
  const action = body.action || req.query.action;

  try {
    if (action === 'start') {
      const input = {
        maxAds: Math.min(Number(body.maxAds) || 12, 24),
        dateRange: body.dateRange || 'all-time',
        sortBy: body.sortBy || 'RECENT',
      };
      if (body.advertiserUrl) input.advertiserUrls = [body.advertiserUrl];
      else input.searchQuery = (body.company || body.keyword || '').trim();
      if (!input.advertiserUrls && !input.searchQuery) return res.status(400).json({ ok: false, reason: 'no_query' });
      if (body.country) input.countryCode = String(body.country).toLowerCase();

      const r = await fetch(`${APIFY}/acts/${ACTOR}/runs?token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.data) return res.status(200).json({ ok: false, reason: 'start_' + r.status, detail: (d && d.error) || null });
      return res.status(200).json({ ok: true, runId: d.data.id, datasetId: d.data.defaultDatasetId, status: d.data.status });
    }

    if (action === 'poll') {
      const runId = body.runId || req.query.runId;
      if (!runId) return res.status(400).json({ ok: false, reason: 'no_runId' });
      const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${token}`);
      const d = await r.json().catch(() => ({}));
      const status = d.data?.status;
      if (status === 'SUCCEEDED') {
        const dsId = d.data.defaultDatasetId;
        const items = await fetch(`${APIFY}/datasets/${dsId}/items?token=${token}&clean=true`).then(x => x.json()).catch(() => []);
        let ads = (Array.isArray(items) ? items : []).map(normalize).filter(Boolean);
        if (body.icp) ads = await scoreAds(ads, body.icp);
        return res.status(200).json({ ok: true, status, ads, count: ads.length });
      }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) return res.status(200).json({ ok: false, status, ads: [] });
      return res.status(200).json({ ok: true, status: status || 'RUNNING', ads: null }); // keep polling
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: 'error', detail: String(e && e.message || e), ads: [] });
  }
}
