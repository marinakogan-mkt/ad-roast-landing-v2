// Helper (underscore prefix => NOT a Vercel function, keeps us under the 12-function
// Hobby cap). Queries the official LinkedIn Ad Library API for an advertiser's live ads.
//
// Auth model: the Ad Library is PUBLIC transparency data. The request is authenticated
// with ONE app/member access token (ours), not a per-end-user token. So Marina generates
// a token once in the LinkedIn developer portal, drops it in Vercel as LINKEDIN_ACCESS_TOKEN,
// and every lookup reuses it. Token TTL is ~2 months; refresh it in Vercel when it expires.
//
// Env vars (Marina adds these in Vercel):
//   LINKEDIN_ACCESS_TOKEN   - the member/app OAuth token (Bearer)
//   LINKEDIN_API_VERSION    - optional, defaults to the current monthly version
//
// IMPORTANT: the exact response shape (esp. the creative image field) is only knowable
// from a real call. normalizeAd() below is defensive and reads the likely field names;
// once we run the first live query we lock the mapping to whatever the JSON actually uses.

const LI_VERSION = process.env.LINKEDIN_API_VERSION || '202608';

function firstOf(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v != null && v !== '') return v;
  }
  return null;
}

// Map one raw Ad Library element to the shape the dashboard renders. Defensive: tries the
// likely field names for each piece. TODO(after first live call): pin exact paths.
function normalizeAd(el) {
  if (!el || typeof el !== 'object') return null;
  const head = firstOf(el, ['commentary', 'adContent.commentary', 'headline', 'adContent.headline', 'text', 'name']);
  // Creative image / preview: LinkedIn returns a creative and/or a preview. Grab whatever
  // hotlinkable image or preview URL is present; else keep the detail/permalink for a link-out.
  const img = firstOf(el, ['creative.imageUrl', 'creative.image', 'adPreview.imageUrl', 'previewImage', 'thumbnail', 'imageUrl', 'creative.thumbnail']);
  const detailUrl = firstOf(el, ['adUrl', 'detailUrl', 'permalink', 'adLibraryUrl', 'url']);
  const advertiser = firstOf(el, ['advertiserName', 'advertiser.name', 'payer.name', 'adPayer']);
  const advertiserUrl = firstOf(el, ['advertiserUrl', 'advertiser.url']);
  const first = firstOf(el, ['firstImpressionAt', 'adStatistics.firstImpressionAt', 'startDate']);
  const last = firstOf(el, ['latestImpressionAt', 'adStatistics.latestImpressionAt', 'endDate']);
  const type = firstOf(el, ['type', 'adType', 'format']);
  if (!head && !img && !detailUrl) return null; // nothing usable
  return {
    plat: 'LinkedIn',
    head: head || '(no headline in transparency record)',
    img: img || null,          // real creative image when present
    detailUrl: detailUrl || null,
    dom: advertiserUrl ? String(advertiserUrl).replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : null,
    advertiser: advertiser || null,
    firstSeen: first || null,
    lastSeen: last || null,
    adType: type || null,
    _raw: el,                  // kept so we can inspect the first real response and lock fields
  };
}

// Fetch a company's LinkedIn ads. Searches by advertiser keyword + countries.
export async function fetchLinkedInAds({ company, keyword, countries = ['US'], limit = 25 }) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) return { ok: false, reason: 'no_token', ads: [] };

  const term = (keyword || company || '').trim();
  if (!term) return { ok: false, reason: 'no_term', ads: [] };

  // Rest.li finder call. Country list encoding for Rest.li 2.0.0 is List(...).
  const countryList = (Array.isArray(countries) ? countries : [countries]).filter(Boolean);
  const qs = [
    'q=criteria',
    'keyword=' + encodeURIComponent(term),
    countryList.length ? 'countries=' + encodeURIComponent('List(' + countryList.join(',') + ')') : '',
    'count=' + limit,
  ].filter(Boolean).join('&');
  const url = 'https://api.linkedin.com/rest/adLibrary?' + qs;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    const res = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        'X-RestLi-Protocol-Version': '2.0.0',
        'LinkedIn-Version': LI_VERSION,
      },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      return { ok: false, reason: 'http_' + res.status, detail: bodyText.slice(0, 300), ads: [] };
    }
    const data = await res.json();
    const els = data.elements || data.data || [];
    const ads = els.map(normalizeAd).filter(Boolean);
    return { ok: true, ads, count: ads.length };
  } catch (e) {
    return { ok: false, reason: 'error', detail: String(e && e.message || e), ads: [] };
  }
}
