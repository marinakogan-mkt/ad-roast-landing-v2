// Vercel serverless function — infer a company's ICP from its website.
// Matches ad-roast-landing-v2 conventions: raw fetch to Anthropic (no SDK),
// x-api-key from env, regex-extracted JSON. Zero new dependencies.
//
//   POST /api/icp   { "url": "acme.com" }
//   → { brand, domain, url, summary, icp_text, tags: [] }
//
// Wire-up: call this when the user enters their site, then use `icp_text` to
// prefill the `icpDescription` field the roast already expects.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function normalizeUrl(input) {
  let raw = (input || '').trim();
  if (!raw) throw new Error('No URL provided.');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const url = new URL(raw);
  const domain = url.hostname.replace(/^www\./, '');
  const brand = domain.split('.')[0];
  return { url: url.toString(), domain, brand: brand.charAt(0).toUpperCase() + brand.slice(1) };
}

async function fetchSite(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
    const desc = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] || '').trim();
    const body = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10000);
    return { title, desc, body };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  let brand, domain, url;
  try {
    ({ brand, domain, url } = normalizeUrl(body.url));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Fetch the site (best-effort — if it fails we infer from the domain alone).
  let site = { title: brand, desc: '', body: '' };
  try { site = await fetchSite(url); } catch (e) { /* keep fallback */ }

  const systemPrompt = `You are a B2B go-to-market analyst. From a page, identify the advertiser company and infer its Ideal Customer Profile — the specific buyer its ads should target. Be concrete about role, company stage, and spend. Do not invent facts that contradict the content.

The page may be the company's own website, OR an ad-library / ad-transparency page (Meta, Google, or LinkedIn) that shows one of the company's ads. If it is an ad-library page, identify the advertiser from the content and infer their real company website.

Return ONLY valid JSON. No markdown, no backticks, no text before or after. Exact shape:
{
  "company": "the advertiser company name",
  "website": "the company's own website as a full https:// URL (best guess)",
  "summary": "2-3 sentences on who this company sells to and the pain those buyers feel",
  "icp_text": "one tight sentence naming the target buyer, company profile, and ad spend",
  "tags": ["4-6 short chips like 'B2B Cybersecurity', 'Series A-C', 'CISOs', '$20K+/mo ad spend'"]
}
Never use em dashes or en dashes in any field value. Use commas, colons, or periods instead.`;

  const userPrompt = `Company domain: ${domain}
Page title: ${site.title}
Meta description: ${site.desc}

Homepage text:
${site.body || '(the site could not be fetched — infer conservatively from the domain name)'}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message || 'API error' });
    }

    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Could not parse ICP response' });
    }
    const icp = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ brand, domain, url, ...icp });
  } catch (error) {
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
}
