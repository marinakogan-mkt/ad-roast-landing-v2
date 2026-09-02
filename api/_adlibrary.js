// Helper (underscore prefix => NOT a Vercel Serverless Function, so it does not count
// against the Hobby 12-function cap). Pulls a company's REAL live ads (with creative
// images) from the LinkedIn Ad Library via the Apify actor, and scores them.
//
// LinkedIn's official Ad Library API returns no creative image, and its ad-library pages
// block server reads (Cloudflare 403), so we use Apify (residential rendering) whose
// output includes mediaUrl = the real creative.
//
// Actor: automation-lab/linkedin-ad-library-scraper (pay-per-event, ~$0.001/ad, no rental)
// Output per ad: advertiserName, advertiserLinkedInUrl, headline, bodyText, ctaLabel,
//   ctaUrl, mediaUrl, adFormat, adId, fundingEntityName, detailUrl.
//
// Env: APIFY_TOKEN (in Vercel). ANTHROPIC_API_KEY is reused for the quick gravity score.
//
// These are called from api/icp.js (action: 'ads-start' / 'ads-poll') so we add no new
// function. Async flow: start returns a runId; poll returns { status, ads:null } while the
// scrape runs, then { status:'SUCCEEDED', ads:[...] } (scored if an icp is passed).

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
    head,
    body: rec.bodyText || '',
    img,
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

// One cheap Haiku call scores the whole set: 1-10 fit-to-ICP + one-line verdict + a fix.
// Best-effort; any failure returns the ads unscored.
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

// Start an Apify run for a company's LinkedIn ads. Returns { ok, runId, datasetId, status }.
export async function apifyStart({ company, advertiserUrl, country, maxAds } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { ok: false, reason: 'no_token' };
  const input = {
    maxAds: Math.min(Number(maxAds) || 12, 24),
    dateRange: 'all-time',
    sortBy: 'RECENT',
  };
  if (advertiserUrl) input.advertiserUrls = [advertiserUrl];
  else input.searchQuery = (company || '').trim();
  if (!input.advertiserUrls && !input.searchQuery) return { ok: false, reason: 'no_query' };
  if (country) input.countryCode = String(country).toLowerCase();
  try {
    const r = await fetch(`${APIFY}/acts/${ACTOR}/runs?token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.data) return { ok: false, reason: 'start_' + r.status, detail: (d && d.error) || null };
    return { ok: true, runId: d.data.id, datasetId: d.data.defaultDatasetId, status: d.data.status };
  } catch (e) { return { ok: false, reason: 'error', detail: String(e && e.message || e) }; }
}

// Poll a run. While running: { ok:true, status, ads:null }. On success: { ok:true, status,
// ads:[...] } (scored if icp given). On failure: { ok:false, status, ads:[] }.
export async function apifyPoll({ runId, icp } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { ok: false, reason: 'no_token', ads: [] };
  if (!runId) return { ok: false, reason: 'no_runId', ads: [] };
  try {
    const r = await fetch(`${APIFY}/actor-runs/${runId}?token=${token}`);
    const d = await r.json().catch(() => ({}));
    const status = d.data?.status;
    if (status === 'SUCCEEDED') {
      const dsId = d.data.defaultDatasetId;
      const items = await fetch(`${APIFY}/datasets/${dsId}/items?token=${token}&clean=true`).then(x => x.json()).catch(() => []);
      let ads = (Array.isArray(items) ? items : []).map(normalize).filter(Boolean);
      if (icp) ads = await scoreAds(ads, icp);
      return { ok: true, status, ads, count: ads.length };
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) return { ok: false, status, ads: [] };
    return { ok: true, status: status || 'RUNNING', ads: null };
  } catch (e) { return { ok: false, reason: 'error', detail: String(e && e.message || e), ads: [] }; }
}
