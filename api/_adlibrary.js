// Helper (underscore prefix => NOT a Vercel Serverless Function, so it does not count
// against the Hobby 12-function cap). Pulls a company's REAL live LinkedIn ads (with the
// actual creative images) for the "Your Live Ads" dashboard.
//
// Why Jina: LinkedIn's official Ad Library API returns no creative image, and its ad-library
// pages block server reads (Cloudflare 403). Jina Reader (r.jina.ai) renders the public
// ad-library search page through its own proxy pool, gets past the block, and is FREE (no
// key needed; an optional JINA_API_KEY raises rate limits). The rendered HTML carries each
// ad's creative as media.licdn.com URLs (data-delayed-url), which are hotlinkable, plus the
// ad copy and the advertiser. We parse those cards and score them.
//
// Env: JINA_API_KEY (optional, higher limits). ANTHROPIC_API_KEY reused for the gravity score.
//
// Called from api/icp.js (action: 'ads-fetch') so we add no new function. Synchronous:
// one fetch + parse + score, no polling.

// Sonnet 4.6 (not Haiku): it reads non-English creative copy and judges buyer-fit far more
// accurately, and unlike Sonnet 5 it still accepts temperature (kept at 0 for determinism).
// Token cost is bounded HARD by scoreAdsCached: only creatives NOT already in the 30-day cache
// are sent to the model, so a re-scored board pays Sonnet vision only for new/changed ads.
// NOTE: if ANTHROPIC_ICP_MODEL is set in the env it overrides this; unset it to use Sonnet 4.6.
const SCORE_MODEL = process.env.ANTHROPIC_ICP_MODEL || 'claude-sonnet-4-6';

function decodeHtml(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…').replace(/&#x27;/g, "'");
}
function stripTags(s) { return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); }
function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Homonym guard. An ad-library search by NAME (LinkedIn accountOwner, Google domain, Meta
// search_terms) can return ads from OTHER companies that share the name: searching "Chaos" (the 3D
// render company, chaos.com) pulls in "Fogo de Chao", a Brazilian steakhouse. Keep only ads whose
// advertiser matches the target company/domain token; if none match but a SINGLE advertiser owns the
// whole result, keep all (a person or agency account that does not contain the brand, e.g.
// semgrep.dev -> "Pablo Estrada"); else (several advertisers, none match) we cannot identify the
// company's own ads, so keep none rather than show a stranger's ads. `extraToks` lets a caller add
// resolved identities (e.g. a LinkedIn company slug) as extra accepted tokens.
function ownedByAdvertiser(ads, { domain = '', company = '', extraToks = [] } = {}) {
  const nn = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const wordsOf = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const toks = [nn(String(domain).replace(/\.[a-z.]+$/i, '')), nn(company), ...extraToks.map(nn)].filter(t => t && t.length >= 4);
  if (!toks.length) return ads; // nothing to match on, don't over-filter
  // Match by WHOLE WORD, not substring: a name search returns near-names (searching "Vanta" pulls
  // "Vantage", "VantaSec"; "Miro" pulls "Mirolin", "Miroslava") that a substring test would wrongly
  // keep. Own it only if a whole word of the advertiser equals the token, the collapsed name equals
  // the token exactly, or (for a long token >= 6 chars, safe from short-name collisions) the token
  // appears glued inside the collapsed name. That keeps sub-brands ("Chaos Cylindo", "Vanta
  // Incorporated", "Notion Labs Japan") while dropping the homonyms.
  const nameMatches = (adv) => {
    const aw = wordsOf(adv);
    const ac = aw.join('');
    if (!ac) return false;
    return toks.some(t => aw.includes(t) || ac === t || (t.length >= 6 && (ac.includes(t) || t.includes(ac))));
  };
  const owned = ads.filter(a => nameMatches(a.advertiser));
  if (owned.length) return owned;
  const distinct = new Set(ads.map(a => nn(a.advertiser))).size;
  return distinct <= 1 ? ads : [];
}

// Parse the rendered ad-library search HTML into ad cards. Each preview card contains the
// advertiser name (a font-bold div), the body copy (commentary__content), and a content
// image anchor (/ad-library/detail/{id}) whose <img data-delayed-url> is the real creative
// and whose alt is the headline. We anchor on that image link and read back for the rest.
function parseAdCards(html, company) {
  const out = [];
  const seen = new Set();
  const anchorRe = /<a href="\/ad-library\/detail\/(\d+)[^"]*ad_library_ad_preview_content_image[\s\S]{0,1400}?<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const block = m[0];
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const imgM = block.match(/data-delayed-url="(https:\/\/media\.licdn\.com[^"]+)"/);
    const altM = block.match(/<img[^>]*\balt="([^"]*)"/);
    const img = imgM ? decodeHtml(imgM[1]) : null;
    const headline = altM ? decodeHtml(altM[1]).trim() : '';
    const pre = html.slice(Math.max(0, m.index - 2600), m.index);
    const adv = [...pre.matchAll(/font-bold[^>]*>\s*([^<]{1,90}?)\s*<\/div>/g)];
    const advertiser = adv.length ? decodeHtml(adv[adv.length - 1][1]).trim() : '';
    const bod = [...pre.matchAll(/commentary__content[^>]*>([\s\S]*?)<\/p>/g)];
    const body = bod.length ? decodeHtml(stripTags(bod[bod.length - 1][1])).trim() : '';
    out.push({ id, advertiser, headline, body, img });
  }
  // Collapse repeats: the same creative often runs across several campaigns and shows up
  // as multiple cards. Keep one per unique creative (by image, falling back to headline).
  const uniq = [];
  const key = new Set();
  for (const a of out) {
    const k = (a.img ? a.img.split('?')[0] : '') || (a.headline || '') || a.id;
    if (key.has(k)) continue;
    key.add(k);
    uniq.push(a);
  }
  // We query by accountOwner (advertiser), so every returned card already belongs to the
  // company; no name filtering needed (and thought-leader ads show a person in the byline).
  return uniq.map(a => ({
    plat: 'LinkedIn',
    head: a.headline || (a.body || '').slice(0, 80) || '(untitled ad)',
    body: a.body || '',
    img: a.img,                 // real creative image (media.licdn.com), or null for text ads
    cta: null,
    ctaUrl: null,
    dom: null,
    advertiser: a.advertiser || null,
    detailUrl: 'https://www.linkedin.com/ad-library/detail/' + a.id,
    adId: a.id,
  }));
}

// One Sonnet 4.6 vision call scores the whole set: 1-10 fit-to-ICP + a diagnosis verdict (what is off
// and WHY it loses the buyer, no fix; the fix is reserved for the full roast).
// Multimodal: each ad contributes a text line AND (capped) its creative image, because the
// copy that sells the ad usually lives ON the creative, and Google image ads carry no
// separate text at all. Images are passed as URL sources (Anthropic fetches them), so we
// don't download them here. Best-effort; any failure returns the ads unscored.
// Fetch a creative and return it as a base64 image block. Anthropic's own URL-image fetch
// silently fails for many ad CDNs (tpc.googlesyndication.com in particular), which made the
// model score image-only ads "no copy, cannot evaluate" = a bogus 1. Fetching server-side
// (same path the /api/icp?img= proxy uses) and sending base64 GUARANTEES the model sees the
// creative, so image-only Google ads get judged on the copy printed on them.
async function _fetchImgB64(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    let r;
    try {
      r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
    } finally { clearTimeout(t); }
    if (!r.ok) return null;
    let ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct === 'image/jpg') ct = 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 4_000_000) return null;
    // Trust the BYTES, not the header. Google (simgad) sometimes serves a real PNG/JPEG with a
    // missing or generic content-type (octet-stream), so a strict header check dropped a valid
    // creative -> the ad reached the scorer with empty copy and no image and got scored "broken" (a
    // false 2 on the prospect's own ad). Sniff the magic bytes and use them when the header isn't a
    // type Anthropic's vision accepts (png/jpeg/gif/webp).
    const sniff = (b) => {
      if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
      if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
      if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
      if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
      return null;
    };
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(ct)) { const m = sniff(buf); if (!m) return null; ct = m; }
    return { media_type: ct, data: buf.toString('base64') };
  } catch (e) { return null; }
}

// Preview artifacts that are never the advertiser's defect (see NOT A DEFECT in the prompt).
// Belt and braces: the prompt forbids them, this removes any chip that slips through anyway.
const ARTIFACT_TAG = /truncat|cut ?off|incomplete|placeholder|dynamic|language|translat|locali[sz]/i;
const stripCut = (s) => String(s || '').replace(/(\s*(\u2026|\.{3}))+\s*$/, '').trim();
// The verdict can still mention the cut in passing when the copy is rendered INSIDE the
// creative image (a Google text ad captured as a picture), where stripCut can't reach it
// (Greenly "...than the truncated body", Stream.security "...and the sitelinks are truncated").
// Drop just that clause at read time, for cached and fresh scores alike. A verdict that is
// ONLY about the cut is left as is: there is nothing true to replace it with.
const CONJ = 'and|but|though|although|while|yet|with|plus';
const ARTIFACT_CLAUSE = new RegExp('\\s*,?\\s*\\b(?:' + CONJ + ')\\b(?:(?!\\b(?:' + CONJ + ')\\b)[^,.;])*?\\b(?:truncat\\w*|cut ?off|incomplete)\\b[^,.;]*', 'gi');
function cleanVerdict(v) {
  if (!v) return v;
  const out = String(v).replace(ARTIFACT_CLAUSE, '').replace(/\s+([.,;])/g, '$1').replace(/[,;]\s*$/, '').trim();
  if (out.split(/\s+/).length < 4) return v;
  return /[.!?]$/.test(out) ? out : out + '.';
}

async function scoreAds(ads, icp) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !icp || !ads.length) return ads;
  const IMG_CAP = 14; // bound the vision tokens per board load
  // Pre-fetch the creatives (parallel, server-side) as base64 so the model actually sees them.
  const toFetch = [];
  for (let i = 0; i < ads.length && toFetch.length < IMG_CAP; i++) {
    if (ads[i].img && /^https:\/\//i.test(ads[i].img)) toFetch.push(i);
  }
  const b64s = await Promise.all(toFetch.map(i => _fetchImgB64(ads[i].img)));
  const imgByIdx = {};
  toFetch.forEach((i, k) => { if (b64s[k]) imgByIdx[i] = b64s[k]; });

  const lines = [];
  const content = [{ type: 'text', text: '' }]; // header filled in after the loop
  for (let i = 0; i < ads.length; i++) {
    const a = ads[i];
    // The ad library cuts copy with a trailing ellipsis; the live ad is complete. The prompt
    // says never to flag truncation, but the model still did (Infiterra, 2026-09-20: "Truncated
    // Body", scored 6). Strip the cut marker so it never SEES a truncation to complain about.
    lines.push(`#${i} [${a.plat}] advertiser="${(a.advertiser || '').slice(0, 60)}" headline="${stripCut(a.head).slice(0, 140)}" body="${stripCut(a.body).slice(0, 220)}"`);
    if (imgByIdx[i]) {
      content.push({ type: 'text', text: `Creative image for ad #${i}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: imgByIdx[i].media_type, data: imgByIdx[i].data } });
    } else if (a.img && /^https:\/\//i.test(a.img)) {
      // Fallback: couldn't fetch it ourselves, let Anthropic try the URL.
      content.push({ type: 'text', text: `Creative image for ad #${i}:` });
      content.push({ type: 'image', source: { type: 'url', url: a.img } });
    }
  }
  content[0].text = `ICP: ${icp}\n\nScore each ad 1-10 for how well it fits this ICP and earns the click (1 = severe mismatch, 10 = excellent). Several ads include their creative image below; READ the copy/text rendered on each creative and judge it as the ad's copy. Ads:\n${lines.join('\n')}`;
  const sys = `You are a B2B ad auditor. Return ONLY a JSON array, one object per ad index (include EVERY index you are given, none skipped), shape: {"i":0,"score":5,"title":"3 to 6 word name for the ad","verdict":"one short diagnosis line","tags":["2 to 4 short labels"],"flag":"OMIT normally; set to \"capture_fail\" ONLY when what was captured is NOT the advertiser's real ad, per the CAPTURE ARTIFACT rule below"}. The title names the ad in a list: for an image ad with no headline text, READ the main line printed on the creative and use that (or a short plain descriptor of the offer), under 6 words, no trailing period. The verdict is ONE short scannable line (max ~14 words) naming the single biggest reason this ad wins or loses the intended buyer: a diagnosis, not a prescription. Do NOT write a paragraph, and do NOT include a fix or an instruction verb (add, make, change, use, swap, put, rewrite); the fix is delivered separately in the full roast. The tags are 2 to 4 VERY short labels (1 to 3 words each, Title Case, no punctuation) that name the specific levers behind the score, so the reader scans them like chips: for a weak ad the missing/broken levers (e.g. "No proof", "Generic hook", "No differentiator", "Weak CTA", "Vague offer", "Wrong buyer"); for a strong ad what it does well (e.g. "Sharp hook", "Clear proof", "Strong CTA"). Base everything on the ad's actual copy (from the text line and, when present, the words on its creative image).

SCORING SCALE (calibrate consistently, the SAME ad must always land on the same score, do NOT cluster at 0-1 or 9-10):
1-3 = actively hurting the click (severe ICP mismatch, no clear value, confusing).
4-6 = generic / average, where MOST real ads land (understandable but forgettable, weak proof or CTA).
7-8 = solid (clear ICP fit, specific value, a real reason to click).
9-10 = best-in-class (sharp hook, strong proof, unmistakable CTA).
An image-only ad with a readable value proposition is NOT a 1: judge the copy shown on the creative. Only score 1-2 when the ad is genuinely broken or badly mismatched to the ICP.

BLANK / EMPTY CREATIVE: if a creative is a blank or collapsed ad slot with NO visible content (a solid or empty image, no text, no logo, no offer), do NOT invent content or a verdict for it. Set title EXACTLY to "Blank ad", score 1, verdict "Empty ad slot, nothing to show." These are filtered out of the board, so a clean canonical title matters.

CAPTURE ARTIFACT (OUR problem, NOT the advertiser's ad): sometimes what was captured is not the real ad but an artifact of scraping the ad library or of how it renders a preview. When you see one of these, set "flag":"capture_fail" and do NOT judge it as the advertiser's ad (still return the row: score 5, a short neutral title, verdict "Capture issue on our side, not the advertiser's ad."). It must NEVER be shown to the advertiser as their broken ad. Treat as capture_fail: (a) an ERROR or SYSTEM page captured instead of an ad (a 4xx/5xx or "Error"/"Something went wrong" page, a Google or system graphic, a blank grey shell); (b) a bare INTERNAL IDENTIFIER or code shown in place of the ad copy (a long number, a hash, a token id, a stray file name) with no real ad message; (c) a creative that clearly belongs to a DIFFERENT advertiser than the one named in advertiser="..." (another company's logo, name, or product, e.g. a construction ad under a fintech advertiser), which means the wrong asset was scraped; (d) template or UI chrome captured as the ad (a cookie banner, a "collapsed ad" tile, a "more" menu, a share button).

NOT A DEFECT (preview / dynamic artifacts, judge the REAL ad, never flag): (a) DYNAMIC KEYWORD INSERTION: the preview shows placeholder tokens like "{keyword}", "{City}", "{Country}", "{location}", or "<dynamically generated location>"; the LIVE ad fills them, so a real user sees "Chicago", not the token. Read PAST the token and judge the ad as if filled. Never call this broken, a typo, or placeholder text. (b) TRUNCATION: the preview often CUTS OFF the copy with an ellipsis or mid-word; the live ad is complete. Never flag "cut off", "incomplete", or "truncated" as a defect. The ONLY real technical defect is a genuine misspelling in the advertiser's OWN words (tag "Typo", name it plainly) - never invent one, and never treat a dynamic token or a preview truncation as one.

BRAND / NON-DEMAND-GEN: some ads are NOT trying to sell the product to a buyer: employer branding, company culture, life-at-company, hiring or recruiting, team or award celebrations, event recaps, thought-leadership with no offer, CSR. These are brand or talent plays, not demand-gen, and that is BY DESIGN. Their low buyer-fit is intentional, NOT a failure, so they must NEVER sit at the bottom of the board or be the "fix this first". HARD RULE: a brand / non-demand-gen post scores EXACTLY 5, never 1-4, no matter how little it speaks to the buyer. Set its verdict to name it plainly, e.g. "Brand / culture post, not a demand-gen ad; judge it on brand lift, not buyer fit." Only a genuine demand-gen ad (offering the product, a demo, trial, or download) that misses the buyer earns a 1-4. When unsure whether an ad is demand-gen or brand, treat a clear product offer or demo/trial/download CTA as demand-gen.

SEGMENT / VERTICAL FIT: the ICP often covers several industries, segments, or buyer roles. An ad aimed at just ONE of them (e.g. a retail ad from a vendor whose ICP includes retail, finance, healthcare, and more) is ON-target for that segment, NOT off-target for being vertical-specific. Judge whether it speaks well to that segment's buyer and pain. Only score it low as a mismatch if the segment or buyer it targets is genuinely OUTSIDE the ICP, never merely because it is narrower than the whole ICP. When the ICP names sweet-spot segments, treat an ad to any of them as in-market.

LOCALIZATION: ads may be localized on purpose, written in another language and aimed at a specific country. That is deliberate, not a defect. Do NOT lower the score for the language or the geo. Read and translate the ad, then judge how well it speaks to the SAME buyer ROLE in its own market. Never make the verdict about the ad being in another language or region-specific, and never say "no ICP signal" or "unclear buyer" when the signal is simply expressed in that language. Judge substance only: hook, clarity, proof, CTA, value for its intended local buyer. HARD RULE: the verdict must NOT contain the words "language", "translated", "translation", "localized", "non-English", "foreign", or a country/region named as the reason. If the only thing "off" about an ad is that it is written in another language, nothing is off: score it on substance and write the verdict about the substance.

PLATFORM LENS: judge each ad by the RIGHT bar for its platform (given as [Google], [LinkedIn], or [Meta]). Intent differs, so the levers differ, and you must SUPPRESS levers that do not apply on a platform rather than score them low or invent a complaint about them.
[Google]: search / text ads are HIGH INTENT (the buyer is already searching). Judge whether the copy matches the likely query and promises a clear, specific outcome, and whether the offer looks relevant to that search. A plain look is NORMAL (a text ad has no creative), and social proof lives on the landing page, so do NOT penalize a Google search ad for "no proof" or a weak visual, and do NOT use tags like "No Proof", "Generic Hook", "Stock Photo" or any creative tag here. Use query and offer tags instead, e.g. "Off Query", "Vague Offer", "Thin Outcome", "Weak CTA", "Weak Sitelinks". EXCEPTION: a Google display or banner ad that DOES carry a creative image is judged on its visual hook like a feed ad.
[LinkedIn]: cold B2B feed, the buyer did not ask for this. Judge the first line hook, a real point of view (punish corporate speak), in feed proof (a named customer, a number, a logo, a real human), and a CTA fit for a cold audience. Proof and POV matter a LOT here. Tags like "Weak Hook", "No POV", "Corporate Speak", "No Proof", "Cold CTA", "No Role Signal".
[Meta]: cold consumer context feed. Judge the CREATIVE first: the opening frame and first few words must stop the scroll, and the creative should feel native, vertical, and readable with sound off. Tags like "Thumb-stop Fail", "Weak First Words", "Wrong Aspect", "Too Polished".

No markdown. Never use em dashes or en dashes; use commas or periods. Output MUST be valid JSON: inside any string value do NOT use raw double quotes (use single quotes for any quoted phrase) and do not use raw newlines.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      // temperature 0: the SAME ads must score the SAME way run to run. Default temp made the
      // board swing (e.g. Google avg 1.1 one run, 7.7 the next) — pure sampling noise, not signal.
      // Sonnet 4.6 accepts temperature (Sonnet 5 rejects it), so determinism is preserved.
      // max_tokens 2000: headroom for up to 14 terse JSON rows. A truncated output fails the JSON
      // parse and wastes the WHOLE call (incl. the expensive vision input), so the cap sits just
      // above real need rather than at it. Billing is by actual output, so the cap is not a cost.
      body: JSON.stringify({ model: SCORE_MODEL, max_tokens: 2000, temperature: 0, system: sys, messages: [{ role: 'user', content }] }),
    });
    const d = await r.json().catch(() => null);
    // HARD FAILURE: the API returned an error (rate limit, no credit, overloaded) or no content.
    // Previously this fell through to `return ads` (unscored) and looked identical to success, so
    // scoreAdsCached reported scoredNew and the board just never filled. THROW so the caller knows
    // the batch failed, can surface the real reason, and does NOT mark these creatives as "scored".
    if (!r.ok || !d || d.error || !d.content) {
      const e = (d && d.error) || {};
      const msg = e.message || e.type || ('HTTP ' + r.status);
      console.error('[scoreAds] Anthropic error status=' + r.status, JSON.stringify(e).slice(0, 300));
      const err = new Error('scoreAds: ' + msg);
      err.status = r.status;
      err.rateLimited = r.status === 429 || r.status === 529 || /rate.?limit|overloaded|credit|billing|quota/i.test((e.type || '') + ' ' + (e.message || ''));
      throw err;
    }
    const txt = d.content?.[0]?.text || '';
    const mm = txt.match(/\[[\s\S]*\]/);
    if (!mm) { console.error('[scoreAds] no JSON array in response:', txt.slice(0, 200)); throw new Error('scoreAds: unparseable response'); }
    let scores;
    try {
      scores = JSON.parse(mm[0]);
    } catch (e1) {
      // ONE malformed row (e.g. an unescaped quote inside a title/verdict) used to fail the whole
      // JSON.parse and waste the entire batch, so the board could never get past that creative.
      // Salvage every well-formed {...} row and skip only the broken one; it retries next pull.
      scores = [];
      const objs = mm[0].match(/\{[^{}]*\}/g) || [];
      for (const o of objs) { try { scores.push(JSON.parse(o)); } catch (e2) { /* skip the bad row */ } }
      if (!scores.length) { console.error('[scoreAds] JSON salvage failed:', String(e1.message), mm[0].slice(0, 300)); throw new Error('scoreAds: JSON parse failed'); }
      console.error('[scoreAds] salvaged ' + scores.length + '/' + objs.length + ' rows after parse error: ' + String(e1.message));
    }
    const byI = {};
    for (const s of scores) if (typeof s.i === 'number') byI[s.i] = s;
    // head falls back to the model's title so image-only Google ads (no headline text) still
    // show a real name in the board/preview instead of "Live creative".
    return ads.map((a, i) => {
      // CAPTURE FAILURE, not a bad ad: the ad reached the model with NO copy (empty headline+body)
      // AND we never got its creative as base64. The model then had nothing real to judge and scores
      // it "broken" (a false low score). That is OUR capture failing, not the advertiser's ad, so it
      // must never appear on the prospect's board as their broken ad. Flag it; isJunkCreative drops it.
      // The model flagged this as a capture artifact (error page, internal identifier, wrong
      // advertiser's brand, UI chrome) - our capture, not the advertiser's ad. Drop it.
      if (byI[i] && byI[i].flag === 'capture_fail') return { ...a, _captureFail: true };
      const blind = !(a.head || '').trim() && !(a.body || '').trim() && !imgByIdx[i];
      if (blind) return { ...a, _captureFail: true };
      return byI[i] ? { ...a, score: byI[i].score, verdict: byI[i].verdict, tags: Array.isArray(byI[i].tags) ? byI[i].tags.filter((t) => !ARTIFACT_TAG.test(String(t))).slice(0, 4) : [], title: byI[i].title || null, head: a.head || byI[i].title || '' } : a;
    });
  } catch (e) {
    // A parse error or a thrown hard-failure: re-throw so scoreAdsCached reports it instead of
    // silently returning unscored ads. (fetch/network errors also land here and propagate.)
    console.error('[scoreAds] failed:', e.message);
    throw e;
  }
}

// --- Per-creative score cache (token optimization) ------------------------------------
// Pulling the ad LIST is FREE (Jina / Google RPC / Meta API, no LLM). The ONLY token cost is
// scoreAds (a Haiku vision call). So instead of caching one scored blob per domain for hours
// (which goes stale the moment the advertiser adds/removes a creative), we cache the SCORE per
// individual creative, keyed by a stable creative signature + a hash of the ICP. On every board
// load we re-pull the current list (cheap) and only send the creatives we've NEVER scored before
// to the model. Unchanged creatives reuse their cached score (0 tokens); a newly launched creative
// costs one score; a paused/removed creative simply isn't in the fresh pull. Result: the board is
// effectively real-time on which ads are live, while tokens are spent only on genuinely new ads.
const ADSCORE_TTL = 60 * 60 * 24 * 30; // 30 days: a creative's fit-to-ICP score doesn't drift.

// Stable id for a creative so the SAME ad maps to the SAME cache slot across pulls. Platform ad
// ids are stable; fall back to the image URL sans query (LinkedIn/Google signed params change).
function creativeSig(a) {
  if (a.adId) return (a.plat || '') + ':id:' + a.adId;
  if (a.img) return (a.plat || '') + ':img:' + String(a.img).split('?')[0];
  return (a.plat || '') + ':h:' + (a.head || a.body || '').slice(0, 80);
}
// Short deterministic hash of the ICP text: a different ICP => a different cache namespace, so a
// re-scored account with a changed buyer definition doesn't reuse stale scores.
function icpHash(icp) {
  const s = String(icp || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Score a pulled ad list, reusing per-creative cached scores and only calling the model on the
// creatives we haven't scored yet. `force` (the Retry button) bypasses the reuse and re-scores all.
// Returns { ads, scoredNew, reused }. If redis is unavailable it just scores everything (old path).
export async function scoreAdsCached(ads, icp, redis, { force = false, limit = 0 } = {}) {
  if (!icp || !ads.length) return { ads, scoredNew: 0, reused: 0, pending: 0 };
  if (!redis) {
    try { const scored = await scoreAds(ads, icp); const n = scored.filter(a => typeof a.score === 'number').length; return { ads: scored, scoredNew: n, reused: 0, pending: ads.length - n }; }
    catch (e) { return { ads, scoredNew: 0, reused: 0, pending: ads.length, scoreError: e.message, rateLimited: !!e.rateLimited }; }
  }
  const ih = icpHash(icp);
  // Namespace bumped over time to invalidate scores made under an older scorer prompt, so a board
  // re-scores under the current rules on its NEXT open. This is LAZY per-board (each open re-scores
  // only that board, batched under the 60s limit): safe as long as boards are opened gradually, NOT a
  // global forced re-score (that once tripped a rate limit). v9 (2026-09-20): the truncation rule
  // was prompt-only and the model ignored it (Infiterra); the cut marker is now stripped before
  // scoring and artifact chips are filtered after. v8 (2026-09-19): capture-artifact rules,
  // so error pages, internal identifiers, a wrong advertiser's creative, dynamic-insertion tokens,
  // preview truncation and foreign-language ads are no longer shown as the advertiser's own defect
  // (was hitting Allstacks, TreviPay, Mambu, SpecterOps, Detectify, Rydoo and more). v7 (2026-09-19):
  // capture-failure gate for a Google ad we couldn't capture (empty copy + no fetchable creative).
  // v6 (2026-09-14):
  // platform-aware lens (Google search = high intent, judged on query match / offer / CTA, never on
  // proof or visual hook; LinkedIn and Meta stay cold-audience). v5 (2026-09-14): one-line diagnosis +
  // chips. v4 (2026-09-14): diagnosis-not-fix verdict (what is off + WHY it loses the buyer, no fix).
  // v3 (2026-09-12): localization / blank / brand rules.
  const keyOf = (a) => 'adscore:v9:' + ih + ':' + creativeSig(a);
  const cachedBySig = {};
  if (!force) {
    try {
      const vals = await redis.mget(...ads.map(keyOf));
      ads.forEach((a, i) => {
        const v = vals && vals[i];
        const o = v ? (typeof v === 'string' ? JSON.parse(v) : v) : null;
        // A cached capture-failure counts as "known" so the ad leaves `need` (no re-score loop) and
        // still gets dropped downstream. Otherwise only a real numeric score is a cache hit.
        if (o && (typeof o.score === 'number' || o._captureFail)) cachedBySig[creativeSig(a)] = o;
      });
    } catch (e) { /* miss -> score all */ }
  }
  const need = ads.filter(a => !cachedBySig[creativeSig(a)]);
  // Bound how many NEW creatives we score in one call: scoreAds is a Sonnet vision call, and the
  // pull + scoring must fit Vercel's 60s function limit. On a big FRESH board that one call 504s, so
  // we score at most `limit` per request and report `pending`; the client re-calls to score the rest
  // (the list is cached by then, so those calls skip the pull). limit 0 = no cap (score everything).
  const toScore = (limit > 0 && need.length > limit) ? need.slice(0, limit) : need;
  const freshBySig = {};
  const failBySig = {}; // creatives our capture couldn't feed the scorer: dropped, never shown as broken
  let scoreError = null, rateLimited = false;
  if (toScore.length) {
    try {
      const scored = await scoreAds(toScore, icp);
      const writes = [];
      for (const a of scored) {
        // Capture failure: remember it (12h TTL) so it drops out of `need` and doesn't loop the
        // client's re-score. Short TTL so a creative that only failed transiently (a timeout / 429)
        // comes back and scores fairly within the day instead of staying hidden.
        if (a._captureFail) { failBySig[creativeSig(a)] = true; writes.push(redis.set(keyOf(a), JSON.stringify({ _captureFail: true }), { ex: 60 * 60 * 12 })); continue; }
        if (typeof a.score !== 'number') continue;
        const o = { score: a.score, verdict: a.verdict, tags: Array.isArray(a.tags) ? a.tags.slice(0, 4) : [], title: a.title || null };
        freshBySig[creativeSig(a)] = o;
        writes.push(redis.set(keyOf(a), JSON.stringify(o), { ex: ADSCORE_TTL }));
      }
      try { await Promise.all(writes); } catch (e) { /* best-effort */ }
    } catch (e) {
      // The scoring call hard-failed (rate limit, no credit, overloaded). Do NOT count these as
      // scored: leave them unscored so pending stays accurate and the client stops looping instead
      // of hammering the API. Surface the real reason so it shows up in the API response + logs.
      scoreError = e.message; rateLimited = !!e.rateLimited;
      console.error('[scoreAdsCached] scoring batch failed:', e.message, 'rateLimited=' + rateLimited);
    }
  }
  const out = ads.map(a => {
    const o = cachedBySig[creativeSig(a)] || freshBySig[creativeSig(a)];
    if (failBySig[creativeSig(a)] || (o && o._captureFail)) return { ...a, _captureFail: true }; // our capture failed; isJunkCreative drops it
    return o ? { ...a, score: o.score, verdict: cleanVerdict(o.verdict), tags: Array.isArray(o.tags) ? o.tags.filter((t) => !ARTIFACT_TAG.test(String(t))) : [], title: o.title || a.title || null, head: a.head || o.title || '' } : a;
  });
  // scoredNew = creatives that ACTUALLY got a number this call (not what we tried). pending falls
  // by real scores AND by capture-failures (resolved: dropped), so a board with an uncapturable
  // creative doesn't loop the client's re-score forever waiting on an ad that can never score.
  const scoredNew = Object.keys(freshBySig).length;
  const failedNew = Object.keys(failBySig).length;
  return { ads: out, scoredNew, reused: Object.keys(cachedBySig).length, pending: Math.max(0, need.length - scoredNew - failedNew), scoreError, rateLimited };
}

// --- LinkedIn (free, via Jina Reader) -------------------------------------------------
// Pull a company's real LinkedIn ads (creative image + copy). Returns UNSCORED cards.
// PRIMARY LinkedIn source: the Apify public LinkedIn Ad Library actor. Unlike Jina's anonymous pool
// (shared IP rate-limit + fingerprinting) this is reliable, needs no login, and is cheap-per-ad
// ($0.0015/ad, capped by maxResults). Needs APIFY_TOKEN. Returns our normalized ad shape, or a
// reason so fetchLinkedInAds can fall back to Jina.
async function fetchLinkedInAdsViaApify({ company, limit = 12 } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { ok: false, reason: 'no_apify_token', ads: [] };
  const q = (company || '').trim();
  if (!q) return { ok: false, reason: 'no_company', ads: [] };
  // countries must be real ISO codes (not "ALL") and dateOption is required — matching the actor's
  // validated example. A spread of major B2B markets so we don't miss a company's ads by region.
  // Force RESIDENTIAL proxies — datacenter proxies (the default/free) get blocked by LinkedIn's
  // Cloudflare, which is exactly why the actor's runs were failing. Residential IPs get through, and
  // a LinkedIn scrape is small (~MBs) so it stays within Apify's free monthly credits.
  const input = { searchTerms: [q], searchMode: 'accountOwner', countries: ['US'], dateOption: 'last-year', maxResults: 20, fetchAdDetails: false, proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000); // cap wasted time when LinkedIn blocks the actor's proxies; falls back to Jina after
    const r = await fetch('https://api.apify.com/v2/acts/khadinakbar~linkedin-ads-scraper/run-sync-get-dataset-items?token=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: c.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: 'apify_' + r.status, ads: [] };
    const items = await r.json();
    if (!Array.isArray(items) || !items.length) return { ok: false, reason: 'apify_no_ads', ads: [] };
    // Field names vary across actor versions, so read each defensively.
    const pick = (o, keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; };
    const ads = items.map(it => {
      const cr = it.creative || it;
      const img = pick(it, ['imageUrl', 'image', 'imageURL', 'creativeImageUrl', 'creativeImage', 'thumbnailUrl']) || pick(cr, ['imageUrl', 'image', 'imageURL']);
      const head = pick(it, ['headline', 'title', 'head']) || pick(cr, ['headline', 'title']) || '';
      const body = pick(it, ['copy', 'body', 'text', 'description', 'commentary']) || pick(cr, ['copy', 'body', 'text']) || '';
      const adId = pick(it, ['adId', 'id', 'adLibraryId']) || (it.url ? (String(it.url).match(/(\d{6,})/) || [])[1] : null);
      const detailUrl = pick(it, ['url', 'adUrl', 'detailUrl', 'sourceUrl']) || (adId ? 'https://www.linkedin.com/ad-library/detail/' + adId : null);
      const advertiser = pick(it, ['advertiserName', 'advertiser', 'payerName', 'accountName']) || null;
      return { plat: 'LinkedIn', head: (head || (body || '').slice(0, 80) || '(untitled ad)'), body: body || '', img, cta: null, ctaUrl: null, dom: null, advertiser, detailUrl, adId };
    }).filter(a => a.img && /^https?:\/\//i.test(String(a.img)));
    // Same ad often repeats across countries — keep one per creative/id.
    const seen = new Set();
    const uniq = [];
    for (const a of ads) { const k = a.adId || String(a.img).split('?')[0]; if (seen.has(k)) continue; seen.add(k); uniq.push(a); }
    const out = uniq.slice(0, limit);
    if (!out.length) return { ok: false, reason: 'apify_no_creatives', ads: [] };
    return { ok: true, ads: out, via: 'apify' };
  } catch (e) { return { ok: false, reason: 'apify_error:' + String(e && e.message || e).slice(0, 40), ads: [] }; }
}

export async function fetchLinkedInAds({ company, domain = '', limit = 12 } = {}) {
  const q = (company || '').trim();
  if (!q) return { ok: false, reason: 'no_company', ads: [] };
  // Try Apify first (reliable, no rate-limit fingerprint); fall back to Jina's anon pool if it's not
  // configured or comes back empty.
  // Apify is wired up (fetchLinkedInAdsViaApify), but the khadinakbar actor is currently broken —
  // even with residential proxies it fails at page 0 ("LinkedIn search requests failed"), so calling
  // it only adds ~18s of latency for nothing. Gate it behind APIFY_LINKEDIN=1 so it's trivial to
  // re-enable once a WORKING actor is found (just set the env var), without slowing pulls today.
  let apifyReason = process.env.APIFY_TOKEN ? (process.env.APIFY_LINKEDIN === '1' ? 'apify_not_run' : 'apify_disabled') : 'apify_no_token';
  if (process.env.APIFY_TOKEN && process.env.APIFY_LINKEDIN === '1') {
    const ap = await fetchLinkedInAdsViaApify({ company: q, limit });
    if (ap.ok && ap.ads && ap.ads.length) { const owned = ownedByAdvertiser(ap.ads, { domain, company: q }); if (owned.length) return { ...ap, ads: owned, _apify: 'ok' }; }
    apifyReason = ap.reason || 'apify_empty';
  }
  const target = 'https://www.linkedin.com/ad-library/search?accountOwner=' + encodeURIComponent(q);
  // A JINA_API_KEY lifts the anonymous rate limit. BUT a depleted/invalid key returns 401/402/403
  // and would make LinkedIn fail HARDER than no key at all — so if a keyed attempt hits one of
  // those, we DROP the key and fall back to Jina's anonymous pool for the remaining attempts.
  // Never let a bad key be worse than no key.
  let useKey = !!process.env.JINA_API_KEY;
  let lastReason = 'error';
  // 2 attempts stay under the 60s function limit (Google runs in parallel; scoring runs after).
  // Attempt 0: default engine (fast; an auth/credit failure returns in ~1s so the key-drop is cheap).
  // Attempt 1: Jina's browser engine, which gets past LinkedIn's Cloudflare far more often.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 600));
    // Jina bills per OUTPUT token, so strip the heavy non-content before it counts: scripts, styles,
    // svg, iframes. These are the bulk of a LinkedIn page's weight and CANNOT contain an ad card
    // (whose detail-anchor + data-delayed-url creative is real DOM), so parseAdCards is unaffected
    // while the returned payload — and the token cost per read — drops sharply. (Deliberately does
    // NOT strip nav/header/footer/aside: tiny extra savings, small risk of eating a card, not worth it.)
    const h = { 'X-Return-Format': 'html', 'X-Timeout': '20', 'X-Remove-Selector': 'script,style,noscript,svg,iframe' };
    if (useKey) h['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
    const lastTry = attempt === 1;
    if (lastTry) h['X-Engine'] = 'browser';
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), lastTry ? 26000 : 15000);
      const r = await fetch('https://r.jina.ai/' + target, { headers: h, signal: controller.signal });
      clearTimeout(t);
      if (!r.ok) {
        lastReason = 'jina_' + r.status + (useKey ? '_keyed' : '_anon');
        // Key out of credits (402) or unauthorized (401/403): drop it, retry anonymously next round.
        if (useKey && (r.status === 402 || r.status === 401 || r.status === 403)) useKey = false;
        continue;
      }
      const html = await r.text();
      // Only keep ads that carry a real creative image — every board card must show a real
      // creative, never a text-only placeholder tile.
      // Filter to the company's OWN ads BEFORE slicing: the accountOwner name search is fuzzy and
      // returns homonyms (searching "Chaos" the 3D-render co pulls in "Fogo de Chao", a steakhouse).
      const ads = ownedByAdvertiser(parseAdCards(html, q).filter(a => a.img), { domain, company: q }).slice(0, limit);
      if (ads.length) return { ok: true, ads, _apify: apifyReason };
      lastReason = 'no_ads';
    } catch (e) { lastReason = String(e && e.message || e); }
  }
  return { ok: false, reason: lastReason, ads: [], _apify: apifyReason };
}

// --- Google (free, via Ads Transparency Center RPC) -----------------------------------
// The Transparency Center site loads an advertiser's ads through an internal RPC that
// needs no auth. We call it directly with the domain and pull the real static creatives
// (tpc.googlesyndication.com/archive/simgad/...). Region 2764 = "anywhere". We keep only
// image creatives so every Google card shows a real creative (display/HTML ads carry no
// static image and no separate copy, so they'd be empty cards). Returns UNSCORED cards.
// A Google "collapsed ad" PLACEHOLDER is a Transparency Center UI artifact, NOT a real creative:
// a reused static simgad asset, tiny, black text on white reading "Collapsed ad on mobile /
// Collapsed ad on desktop / Expanded ad / more_vert". Google occasionally returns it as if it were
// an ad. It must never reach the board (we'd tell an advertiser their worst ad is an empty slot) or
// the counts. Detect it three ways so BOTH fresh pulls and already-cached/scored boards are covered:
// a known placeholder simgad id, a tiny render size, or a scorer verdict that flagged it blank.
export const GOOGLE_PLACEHOLDER_SIMGAD = new Set(['6364307266515146391']);
export function isJunkCreative(a) {
  if (!a) return true;
  if (a._captureFail) return true; // our capture gave the scorer nothing real; never show it as the advertiser's broken ad
  const id = (String(a.img || '').match(/simgad\/(\d+)/) || [])[1];
  if (id && GOOGLE_PLACEHOLDER_SIMGAD.has(id)) return true;                 // the reused placeholder asset
  if (a._w && a._h && a._w < 200 && a._h < 100) return true;               // too small to be a real ad creative
  const t = (String(a.title || a.head || '') + ' ' + String(a.verdict || '')).toLowerCase();
  if (/collapsed ad on (mobile|desktop)|expanded ad|more_vert/.test(t)) return true;
  if (/\b(blank|empty|collapsed)\b[\s\S]*\b(ad|unit|slot|creative)\b/.test(t) || t.indexOf('empty ad slot') !== -1 || t.indexOf('nothing to show') !== -1) return true;
  return false;
}
export const dropJunkCreatives = (ads) => (Array.isArray(ads) ? ads.filter(a => !isJunkCreative(a)) : ads);

export async function fetchGoogleAds({ domain, company, limit = 12 } = {}) {
  const dom = (domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();
  if (!dom) return { ok: false, reason: 'no_domain', ads: [] };
  const url = 'https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=';
  const reqBody = 'f.req=' + encodeURIComponent(JSON.stringify({ '2': 40, '3': { '12': { '1': dom, '2': true } }, '7': { '1': 1, '2': 0, '3': 2764 } }));
  let data;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-same-domain': '1',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': '*/*',
      },
      body: reqBody,
      signal: c.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: 'google_' + r.status, ads: [] };
    data = JSON.parse(await r.text());
  } catch (e) { return { ok: false, reason: 'google_error', detail: String(e && e.message || e), ads: [] }; }

  const arr = Array.isArray(data && data['1']) ? data['1'] : [];
  const ads = [];
  const seen = new Set();
  for (const c of arr) {
    const cr = c && c['3'];
    const htmlImg = cr && cr['3'] && cr['3']['2'];   // image creatives: an <img src="...simgad..."> string
    let img = null;
    if (typeof htmlImg === 'string') {
      const m = htmlImg.match(/https:\/\/tpc\.googlesyndication\.com\/archive\/simgad\/\d+/);
      if (m) img = m[0];
    }
    if (!img || seen.has(img)) continue;
    // Drop Google's "collapsed ad" placeholder at the source (by known id or tiny render size) so it
    // never gets scored (wasted vision call) or shown as an empty slot.
    const _w = parseFloat((htmlImg.match(/width="?([\d.]+)/) || [])[1] || 0);
    const _h = parseFloat((htmlImg.match(/height="?([\d.]+)/) || [])[1] || 0);
    if (isJunkCreative({ img, _w, _h })) continue;
    seen.add(img);
    const AR = c['1'], CR = c['2'];
    ads.push({
      plat: 'Google', head: '', body: '', img,
      cta: null, ctaUrl: null, dom,
      advertiser: c['12'] || null,
      detailUrl: (AR && CR) ? `https://adstransparency.google.com/advertiser/${AR}/creative/${CR}?region=anywhere` : 'https://adstransparency.google.com/?region=anywhere&domain=' + encodeURIComponent(dom),
      adId: CR || null,
    });
  }
  // Google's domain search returns creatives from EVERY advertiser whose ads point at this domain.
  // For a normal company that's just them (semgrep.dev -> one advertiser). But a shared site-host
  // domain (notion.so, carrd.co, framer.website, ...) returns unrelated small businesses that use
  // it to host their landing page (a stone-crusher factory, a Korean dev shop). Keep only the
  // company's OWN ads:
  //  - advertisers whose name matches the company/domain token (notion -> "Notion Labs Japan"), else
  //  - if a SINGLE advertiser owns the whole result the domain maps cleanly to one account, which can
  //    be a person/agency name that does not contain the brand (semgrep.dev -> "Pablo Estrada"), so
  //    keep all; else (several advertisers, none match) it is a shared host with no owned ads -> none.
  const kept = ownedByAdvertiser(ads, { domain: dom, company });
  return { ok: true, ads: kept.slice(0, limit) };
}

// ---- Meta (Facebook + Instagram) via the OFFICIAL Ad Library API ----------------------------
// Requires META_ADLIBRARY_TOKEN (a Meta access token from an identity-confirmed Meta app).
// Without it we return nothing and the UI keeps Meta as "coming soon". The API only exposes
// non-political ("commercial") ads that were delivered in the EU/UK (a DSA effect) plus
// political/issue ads globally — so for a US-only advertiser this is often empty, which is
// EXPECTED, not a bug. We query the full EU-27 + UK with ad_type=ALL (the maximum coverage the
// API allows) and resolve each creative image from its snapshot page.
const META_EU_UK = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB'];

async function _fetchMetaSnapshot(url) {
  // ad_snapshot_url embeds the access token and is fetchable server-side (unlike the bot-walled
  // public library page). Its HTML carries the creative URLs in embedded JSON — pull the first
  // usable image + destination link + CTA text.
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    let r;
    try { r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' } }); } finally { clearTimeout(t); }
    if (!r.ok) return {};
    const html = await r.text();
    const unesc = (s) => s ? s.replace(/\\\//g, '/').replace(/\\u003D/gi, '=').replace(/\\u0026/gi, '&') : s;
    const pick = (re) => { const m = html.match(re); return m ? unesc(m[1]) : null; };
    const img = pick(/"original_image_url":"(https:[^"]+)"/) || pick(/"resized_image_url":"(https:[^"]+)"/) || pick(/"video_preview_image_url":"(https:[^"]+)"/);
    const link = pick(/"link_url":"(https?:[^"]+)"/);
    const cta = pick(/"cta_text":"([^"]+)"/);
    return { img, link, cta };
  } catch (e) { return {}; }
}

export async function fetchMetaAds({ company, domain, limit = 12 } = {}) {
  const token = process.env.META_ADLIBRARY_TOKEN;
  if (!token) return { ok: false, reason: 'no_token', ads: [] };
  const term = (company || domain || '').trim();
  if (!term) return { ok: false, reason: 'no_query', ads: [] };
  const params = new URLSearchParams({
    access_token: token,
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    ad_reached_countries: JSON.stringify(META_EU_UK),
    search_terms: term,
    fields: 'id,page_id,page_name,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,ad_snapshot_url,publisher_platforms,ad_delivery_start_time',
    limit: '25',
  });
  const url = 'https://graph.facebook.com/v21.0/ads_archive?' + params.toString();
  let data;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    let r;
    try { r = await fetch(url, { signal: c.signal }); } finally { clearTimeout(t); }
    data = await r.json();
    if (data && data.error) {
      const e = data.error;
      // Surface the full Meta error (code + subcode + message) so we can diagnose exactly why a
      // valid token still fails (e.g. permission, identity confirmation, verification).
      const detail = 'meta_error:' + (e.code || '') + (e.error_subcode ? '/' + e.error_subcode : '') + ':' + String(e.message || '').slice(0, 180);
      return { ok: false, reason: detail, ads: [] };
    }
  } catch (e) { return { ok: false, reason: 'meta_fetch_failed', ads: [] }; }
  let items = Array.isArray(data.data) ? data.data : [];
  // search_terms is fuzzy — keep only ads whose Page name plausibly matches the advertiser.
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(company || domain);
  if (want) items = items.filter(a => { const pn = norm(a.page_name); return pn && (pn.indexOf(want) !== -1 || want.indexOf(pn) !== -1); });
  items = items.slice(0, limit);
  const enriched = await Promise.all(items.map(async (a) => {
    const snap = a.ad_snapshot_url ? await _fetchMetaSnapshot(a.ad_snapshot_url) : {};
    const body = (a.ad_creative_bodies && a.ad_creative_bodies[0]) || '';
    const head = (a.ad_creative_link_titles && a.ad_creative_link_titles[0]) || (a.ad_creative_link_captions && a.ad_creative_link_captions[0]) || (body ? body.slice(0, 80) : '(untitled ad)');
    return {
      plat: 'Meta',
      head,
      body,
      img: snap.img || null,
      cta: snap.cta || null,
      ctaUrl: snap.link || null,
      dom: null,
      advertiser: a.page_name || null,
      region: 'EU/UK',
      detailUrl: a.ad_snapshot_url || ('https://www.facebook.com/ads/library/?q=' + encodeURIComponent(term)),
      adId: a.id,
    };
  }));
  return { ok: true, ads: enriched, reason: enriched.length ? 'ok' : 'no_ads' };
}

// Merge a company's real ads across sources (LinkedIn + Google + Meta EU/UK), score the whole
// set in one pass, and return one list. Each source is best-effort: one failing never sinks the
// others. Meta only returns data when META_ADLIBRARY_TOKEN is set and the advertiser ran ads in
// the EU/UK; otherwise the UI keeps Meta as "coming soon".
export async function fetchAllAds({ company, domain, icp, limit = 36 } = {}) {
  const [li, gg, mt] = await Promise.all([
    fetchLinkedInAds({ company, domain, limit: 12 }).catch(() => ({ ok: false, ads: [] })),
    fetchGoogleAds({ domain, company, limit: 12 }).catch(() => ({ ok: false, ads: [] })),
    fetchMetaAds({ company, domain, limit: 12 }).catch(() => ({ ok: false, ads: [], reason: 'meta_fetch_failed' })),
  ]);
  const sources = { linkedin: (li.ads || []).length, google: (gg.ads || []).length, meta: (mt.ads || []).length };
  // Surface why a source came back empty (e.g. LinkedIn Jina rate-limit, Meta no-token) even when
  // another source succeeded, so the UI can tell "none running" from "we couldn't fetch it".
  const notes = {
    linkedin: (li.ads && li.ads.length) ? 'ok' : (li.reason || 'no_ads'),
    linkedin_apify: li._apify || null, // debug: why Apify was/wasn't used for LinkedIn
    google: (gg.ads && gg.ads.length) ? 'ok' : (gg.reason || 'no_ads'),
    meta: (mt.ads && mt.ads.length) ? 'ok' : (mt.reason || 'no_ads'),
  };
  let ads = [...(li.ads || []), ...(gg.ads || []), ...(mt.ads || [])].slice(0, limit);
  if (!ads.length) return { ok: false, reason: (li.reason || gg.reason || mt.reason || 'no_ads'), ads: [], sources, notes };
  if (icp) ads = await scoreAds(ads, icp);
  return { ok: true, ads, count: ads.length, sources, notes };
}

// Back-compat: LinkedIn-only fetch + score (kept for any caller still using it).
export async function fetchAdsViaJina({ company, icp, limit = 12 } = {}) {
  const li = await fetchLinkedInAds({ company, limit });
  if (!li.ok) return li;
  let ads = li.ads;
  if (icp && ads.length) ads = await scoreAds(ads, icp);
  return { ok: true, ads, count: ads.length };
}
