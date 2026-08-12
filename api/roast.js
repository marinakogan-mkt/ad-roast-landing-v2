import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';
import { readSessionCookie } from './auth/_allowlist.js';
import { consumeToken, peekAccount } from './_tokens.js';

const _redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

/* Resolve the current roast-tool account (mode:'roast') from the session cookie.
   Returns the lowercased email or null. Portal sessions are ignored here — the
   roast paywall only ever counts against roast accounts. */
async function roastAccountEmail(req) {
  try {
    const token = readSessionCookie(req);
    if (!token) return null;
    const raw = await _redis.get(`auth:session:${token}`);
    if (!raw) return null;
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (s && s.mode === 'roast' && s.email) return String(s.email).trim().toLowerCase();
    return null;
  } catch (e) {
    return null;
  }
}

/* Static locked teaser (optimization #2): served — blurred — to callers who have
   no tokens and no cached prior roast, so the paywall has plausible content behind
   it WITHOUT spending an Anthropic call. Real scores/text are never exposed here. */
const LOCKED_SAMPLE = {
  icp_mismatch: 'Unlock to see how well this ad matches your ICP.',
  overall_score: 5,
  issues: [
    { category: 'headline_clarity', title: 'Headline Clarity', score: 5, explanation: 'Unlock to reveal.' },
    { category: 'cta_friction', title: 'CTA Friction', score: 5, explanation: 'Unlock to reveal.' },
    { category: 'visual_copy_match', title: 'Visual-Copy Match', score: 5, explanation: 'Unlock to reveal.' },
    { category: 'benefit_specificity', title: 'Benefit Specificity', score: 5, explanation: 'Unlock to reveal.' },
    { category: 'trust_signals', title: 'Trust Signals', score: 5, explanation: 'Unlock to reveal.' }
  ],
  landing_page_roast: {
    overall_score: 0, headline_score: 0, headline_feedback: '', value_prop_score: 0, value_prop_feedback: '',
    cta_score: 0, cta_feedback: '', trust_score: 0, trust_feedback: '', top_issues: [], quick_wins: []
  },
  ad_landing_mismatch: { alignment_score: 0, verdict: '', disconnects: [], message_match_issues: '' },
  fix_kit: { headlines: ['Unlock', 'Unlock', 'Unlock'], body: 'Unlock to reveal.', ctas: ['Unlock', 'Unlock'], landing_page_headline: 'Unlock to reveal.', landing_page_subhead: 'Unlock to reveal.', rationale: 'Unlock to reveal.' },
  experiments: [
    { title: 'Unlock to reveal', description: 'Unlock to reveal.' },
    { title: 'Unlock to reveal', description: 'Unlock to reveal.' },
    { title: 'Unlock to reveal', description: 'Unlock to reveal.' }
  ],
  next_steps: ['Unlock to reveal.', 'Unlock to reveal.', 'Unlock to reveal.', 'Unlock to reveal.']
};

/* Static output schema (optimization #5). Lives in the cached system prefix so the
   ~500-token JSON contract is billed once (cache read ~0.1x) instead of at full
   input price on every roast. Score fields are described statically; whether to use
   1-10 vs 0 is driven by the CRITICAL RULES and the per-request "Landing page content
   available" flag in the user message, so no per-request interpolation is needed. */
const OUTPUT_CONTRACT = `OUTPUT CONTRACT — return ONLY this JSON object (all fields required; no markdown, no backticks, no text before or after). For landing_page_roast and ad_landing_mismatch scores: use real 1-10 numbers when landing page content is available, otherwise 0.
{
  "icp_mismatch": "string",
  "overall_score": <number 1-10>,
  "issues": [
    {"category": "headline_clarity", "title": "Headline Clarity", "score": <1-10>, "explanation": "string"},
    {"category": "cta_friction", "title": "CTA Friction", "score": <1-10>, "explanation": "string"},
    {"category": "visual_copy_match", "title": "Visual-Copy Match", "score": <1-10>, "explanation": "string"},
    {"category": "benefit_specificity", "title": "Benefit Specificity", "score": <1-10>, "explanation": "string"},
    {"category": "trust_signals", "title": "Trust Signals", "score": <1-10>, "explanation": "string"}
  ],
  "landing_page_roast": {
    "overall_score": <1-10 if landing content available, else 0>,
    "headline_score": <1-10 or 0>,
    "headline_feedback": "string",
    "value_prop_score": <1-10 or 0>,
    "value_prop_feedback": "string",
    "cta_score": <1-10 or 0>,
    "cta_feedback": "string",
    "trust_score": <1-10 or 0>,
    "trust_feedback": "string",
    "top_issues": ["string", "string", "string"],
    "quick_wins": ["string", "string", "string"]
  },
  "ad_landing_mismatch": {
    "alignment_score": <1-10 if landing content available, else 0>,
    "verdict": "string",
    "disconnects": [{"problem": "string", "fix": "string"}],
    "message_match_issues": "string"
  },
  "fix_kit": {
    "headlines": ["string", "string", "string"],
    "body": "string",
    "ctas": ["string", "string"],
    "button_cta": "string (ONLY for LinkedIn/Meta: the single best pre-set CTA button label chosen from that platform's fixed list below. Empty string \"\" for Google or when no button applies)",
    "button_cta_reason": "string (one short sentence on why that button beats the alternatives for this offer. Empty string \"\" when button_cta is empty)",
    "landing_page_headline": "string",
    "landing_page_subhead": "string",
    "rationale": "string"
  },
  "experiments": [
    {"title": "string", "description": "string"},
    {"title": "string", "description": "string"},
    {"title": "string", "description": "string"}
  ],
  "next_steps": ["string", "string", "string", "string"]
}

BREVITY — write every string as a punchy, skimmable fragment: no filler, no restating the field name, lead with the problem or the noun, cut articles where natural. A busy operator should grasp each in one glance. Hard word caps: icp_mismatch <=22. issues[].explanation <=14. landing_page_roast *_feedback <=12. top_issues/quick_wins item <=9. ad_landing_mismatch.verdict <=18, disconnects[].problem/fix <=12, message_match_issues <=14. fix_kit.body <=26 (usable ad body copy), rationale <=16. experiments[].description <=13. next_steps item <=11.`;

export default async function handler(req, res) {
  const API_VERSION = 'v4';

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', _version: API_VERSION });
  }

  // Safeguard: manually parse body if Vercel didn't auto-parse it
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) { body = {}; }
  }
  if (!body || typeof body !== 'object') {
    body = {};
  }

  const { platform, offerType, icpDescription, landingUrl, adCopy, visualDescription, hasImage, landingCopy, variants, isAdvancedAudit, adScreenshot, adScreenshotType } = body;

  /* Pre-LLM token gate (optimization #2): a roast only warrants an Anthropic call
     when the caller is a signed-in account WITH tokens. Out-of-token or anonymous
     callers get a gated (blurred) response with NO model call and NO scraping —
     re-serving their last real roast when we have one, else a static locked sample.
     This kills the "spend a full Sonnet call just to show a blur they already saw"
     waste on every out-of-token retry. Redis failure fails OPEN (treat as entitled)
     so a transient outage never wrongly blocks a paying user. */
  const acctEmail = await roastAccountEmail(req);
  let acctBal = null, redisDown = false;
  if (acctEmail) {
    try { acctBal = await peekAccount(_redis, acctEmail); }
    catch (e) { redisDown = true; console.error('[AdRoast] peek failed:', e.message); }
  }
  const entitled = redisDown || !!(acctEmail && acctBal && acctBal.tokens > 0);
  if (!entitled) {
    let cached = null;
    if (acctEmail) {
      try { const raw = await _redis.get(`roast:last:${acctEmail}`); cached = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; }
      catch (e) {}
    }
    const gated = cached || LOCKED_SAMPLE;
    gated._gated = true;
    gated._version = API_VERSION;
    gated._entitlement = acctEmail
      ? { authed: true, email: acctEmail, full: false, remaining: 0, plan: (acctBal && acctBal.plan) || 'free' }
      : { authed: false, email: null, full: false, remaining: 0, plan: null };
    return res.status(200).json(gated);
  }

  /* Dedupe (token optimization): an identical re-roast — byte-identical inputs —
     returns the previously generated result from cache with NO Anthropic call and
     NO token spend. Keyed per-account so one account can never mint roasts off
     another's cache. TTL 7d bounds staleness (a changed landing page re-roasts once
     the entry expires). Only entitled callers reach here, so this is a pure saving. */
  // Normalize inputs before hashing so trivial, roast-irrelevant differences (letter
  // case, extra whitespace, www./trailing slash, tracking query params) still hit the
  // free cache instead of paying for a fresh, effectively-identical roast.
  const _norm = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').toLowerCase() : s);
  const _normUrl = (u) => {
    if (typeof u !== 'string' || !u.trim()) return u;
    try { const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); }
    catch (e) { return _norm(u); }
  };
  const dedupeHash = crypto.createHash('sha256')
    .update(JSON.stringify({ platform: _norm(platform), offerType: _norm(offerType), icpDescription: _norm(icpDescription), landingUrl: _normUrl(landingUrl), adCopy: _norm(adCopy), visualDescription: _norm(visualDescription), landingCopy: _norm(landingCopy), isAdvancedAudit: !!isAdvancedAudit, variants: variants || null, adScreenshot: adScreenshot || null }))
    .digest('hex');
  const dedupeKey = acctEmail ? `roast:dedupe:${acctEmail}:${dedupeHash}` : null;
  if (dedupeKey && !redisDown) {
    try {
      const raw = await _redis.get(dedupeKey);
      const hit = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (hit && hit.overall_score) {
        hit._deduped = true;
        hit._version = API_VERSION;
        hit._entitlement = { authed: true, email: acctEmail, full: true, remaining: (acctBal && typeof acctBal.tokens === 'number') ? acctBal.tokens : null, plan: (acctBal && acctBal.plan) || 'free' };
        console.log('[AdRoast v4] Dedupe hit — served cached roast, no model call, no token spent for', acctEmail);
        return res.status(200).json(hit);
      }
    } catch (e) {}
  }

  console.log('[AdRoast v4] Request body type:', typeof req.body);
  console.log('[AdRoast v4] Request body keys:', Object.keys(body));
  console.log('[AdRoast v4] Received:', {
    platform,
    offerType,
    adCopyLen: adCopy?.length || 0,
    landingUrl: landingUrl || 'none',
    landingCopyLen: landingCopy?.length || 0
  });

  // Track what content we actually have
  const meta = {
    _version: API_VERSION,
    bodyType: typeof req.body,
    bodyKeys: Object.keys(body),
    hasAdCopy: !!adCopy?.trim(),
    adCopyLength: adCopy?.trim()?.length || 0,
    hasLandingUrl: !!landingUrl?.trim(),
    hasLandingCopy: !!landingCopy?.trim(),
    landingCopyLength: landingCopy?.trim()?.length || 0,
    landingScraped: false,
    landingScrapeError: null,
    adUrlDetected: null,
    adUrlScrape: null
  };

  // ADVANCED INTERNAL AUDIT: if a structured variants[] array is included, format it
  // into a rich multi-variant ad block. The pre-formatted adCopy string from the client
  // is still used, but we annotate the prompt so the LLM treats this as a multi-variant
  // analysis rather than a single ad.
  if (isAdvancedAudit && Array.isArray(variants) && variants.length > 0) {
    meta.advancedAudit = true;
    meta.variantCount = variants.length;
    meta.totalHeadlines = variants.reduce((s, v) => s + (v.headlines?.filter(h => h && h.trim()).length || 0), 0);
    meta.totalDescriptions = variants.reduce((s, v) => s + (v.descriptions?.filter(d => d && d.trim()).length || 0), 0);
  }

  // If adCopy is actually a URL (e.g. LinkedIn / Meta / Google ad-library link),
  // fetch the page and extract OG tags + body text to use as the ad copy for the LLM prompt.
  let effectiveAdCopy = adCopy;
  const adCopyTrim = (adCopy || '').trim();
  if (/^https?:\/\/\S+$/i.test(adCopyTrim)) {
    const platformDetected = /linkedin\.com\/ad-library|linkedin\.com\/posts/i.test(adCopyTrim) ? 'linkedin'
      : /facebook\.com\/ads\/library|fb\.com\/ads\/library/i.test(adCopyTrim) ? 'meta'
      : /adstransparency\.google\.com/i.test(adCopyTrim) ? 'google'
      : 'unknown';
    meta.adUrlDetected = { url: adCopyTrim, platform: platformDetected };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      const r = await fetch(adCopyTrim, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: ctrl.signal,
        redirect: 'follow'
      });
      clearTimeout(t);
      const html = await r.text();
      const ogTitle = (html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] || '').trim();
      const ogDesc = (html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)/i)?.[1] || '').trim();
      const ogImage = (html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i)?.[1] || '').trim();
      const pageTitle = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
      const metaDesc = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)?.[1] || '').trim();
      const bodyText = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3000);
      const parts = [];
      const title = ogTitle || pageTitle;
      const description = ogDesc || metaDesc;
      if (title) parts.push('Headline: ' + title);
      if (description) parts.push('Description / Body: ' + description);
      if (ogImage) parts.push('Creative Image URL: ' + ogImage);
      const extracted = parts.join('\n');
      if ((extracted.length + bodyText.length) >= 50) {
        meta.adUrlScrape = { success: true, platform: platformDetected, statusCode: r.status, contentChars: extracted.length + bodyText.length };
        effectiveAdCopy = '[Ad URL: ' + adCopyTrim + ' (platform: ' + platformDetected + ')]\n\n' + extracted + (bodyText && bodyText.length > 100 ? '\n\nPAGE TEXT:\n' + bodyText : '');
      } else {
        meta.adUrlScrape = { success: false, platform: platformDetected, statusCode: r.status, error: 'No extractable content (page may be JS-rendered or blocked)' };
        effectiveAdCopy = '[Ad URL provided: ' + adCopyTrim + ' (platform: ' + platformDetected + ')]\n[Auto-fetch returned minimal content; analysis based on URL alone]';
      }
    } catch (e) {
      meta.adUrlScrape = { success: false, platform: platformDetected, error: e.message };
      effectiveAdCopy = '[Ad URL provided: ' + adCopyTrim + ' (platform: ' + platformDetected + ')]\n[Auto-fetch failed: ' + e.message + ']';
    }
  }

  // Fetch landing page content if URL provided
  let landingPageContent = '';
  if (landingUrl?.trim()) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const pageRes = await fetch(landingUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);
      const html = await pageRes.text();
      
      // Extract text content, removing scripts/styles
      // Optimization #3: trim the raw page dump to ~3.5K chars. The key elements
      // (title / H1s / meta) are extracted separately below, so a shorter body
      // keeps the signal while cutting input tokens per roast substantially.
      landingPageContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3500);
      
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const h1Match = html.match(/<h1[^>]*>([^<]*)<\/h1>/gi);
      const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
      
      const extractedElements = [];
      if (titleMatch) extractedElements.push(`Page Title: ${titleMatch[1]}`);
      if (h1Match) extractedElements.push(`H1 Headlines: ${h1Match.slice(0, 3).map(h => h.replace(/<[^>]+>/g, '')).join(' | ')}`);
      if (metaDesc) extractedElements.push(`Meta Description: ${metaDesc[1]}`);
      
      if (extractedElements.length > 0) {
        landingPageContent = `EXTRACTED ELEMENTS:\n${extractedElements.join('\n')}\n\nPAGE CONTENT:\n${landingPageContent}`;
      }
      
      if (landingPageContent.trim().length > 50) {
        meta.landingScraped = true;
      } else {
        landingPageContent = '';
        meta.landingScrapeError = 'Page returned empty or minimal content';
      }
    } catch (e) {
      meta.landingScrapeError = e.message;
      landingPageContent = '';
    }
  }

  const hasAnyLandingContent = !!(landingPageContent || landingCopy?.trim());

  const systemPrompt = `You are AdRoast, a brutally honest ad and landing-page analyst for SaaS founders.

Job: (1) judge whether the AD speaks to the user's stated ICP; (2) if landing-page content is provided, analyze the LANDING PAGE for conversion issues; (3) if both exist, find the MESSAGING MISMATCH between them.

Voice: direct, sarcastic but not mean. Apply the "barbecue test" (would this copy make sense at a casual BBQ?). Cite specific copy from ad AND landing page. Harsh but fair: most deserve 4-6.

Scoring (1-10): 1-3 hurting conversions, 4-6 generic, 7-8 solid, 9-10 best-in-class.

CRITICAL RULES:
- BREVITY: read on screen, skimmable in under a minute. Every explanation, feedback line, and verdict = 1-2 tight sentences (max ~30 words), point first, no preamble, no filler. Fix-kit headlines and CTAs stay short. One sharp sentence beats three vague ones.
- Return ONLY valid JSON: no markdown, no backticks, no text before or after.
- ALWAYS include every section: issues, landing_page_roast, ad_landing_mismatch, fix_kit, experiments, next_steps.
- Landing-page content provided -> landing_page_roast and ad_landing_mismatch scores are real 1-10 (never 0 or null). No landing content -> set those scores to 0.
- NEVER state what you cannot do. No capability disclaimers ("can't assess visuals", "without seeing the screenshot", "no visual provided", etc.). If you can't analyze something, skip it silently. The user sees only confident findings.
- PUNCTUATION: no em dashes or en dashes in any field. Use commas, colons, periods, or parentheses.

PLATFORM TRUST-SIGNAL RULES:
- Google Search RSAs and all Google extensions (sitelinks, callouts, structured snippets, seller ratings) are TEXT-ONLY: they never render customer logos, vendor/certification/security/compliance badges (SOC 2, ISO 27001, G2), or screenshots inside the ad.
- When Platform is "google" or "google_ads": no issue or fix may mention or recommend logos, badges of any kind, or images/screenshots in the ad. Rewrite a would-be "no logos/badges" trust_signals point as what the ad TEXT lacks: no named-customer mentions in copy, no callout-extension ratings, no structured-snippet customer list, no numeric proof in headlines, no seller ratings. Text-native trust forms only:
    • Named customers in headlines/descriptions ("Used by Stripe, GitLab")
    • Callout extensions (25 chars): "4.7★ G2", "50k+ orgs", "SOC 2 Type II"
    • Structured snippet headers ("Featured customers:", "Certifications:")
    • Sitelinks to customer-story or compliance pages
    • Seller ratings, numeric proof in copy ("50k+ orgs · 4.7/5")
- LinkedIn and Meta DO support logos and badges in the creative: image-based trust signals are valid there.
- LANDING PAGE recommendations: logos/badges/screenshots are ALWAYS valid (they live on the LP, not the ad). Always state whether a recommendation targets the ad or the LP.

CTA RULES — three separate CTA surfaces, never blur them:
  1. PRE-SET CTA BUTTON: on LinkedIn/Meta a fixed dropdown from a closed list (not free text; you cannot invent a label).
  2. WRITTEN CTA in the ad copy or creative (free text, e.g. "See the 2-minute teardown").
  3. LANDING PAGE CTA (button/headline on the destination page).
- LinkedIn pre-set button options, choose ONLY from: Apply, Download, View Quote, Learn More, Sign Up, Subscribe, Register, Join, Attend, Request Demo, Get Quote, Get Started.
- Meta pre-set button options, choose ONLY from: Learn More, Sign Up, Subscribe, Download, Get Quote, Request Time, Book Now, Contact Us, Apply Now, Get Started, Shop Now, Watch More, Send Message.
- Platform linkedin or meta: set fix_kit.button_cta to the single best label from that platform's list for this offer (book-a-demo -> "Request Demo"/"Sign Up"; self-serve trial -> "Sign Up"/"Get Started"; top-of-funnel content -> "Learn More"/"Download"), and fix_kit.button_cta_reason to one sentence on why it beats "Learn More" (the lazy default). fix_kit.ctas are SEPARATE free-text copy/creative CTAs; the LP CTA is landing_page_headline/subhead. Keep all three consistent but distinct.
- Platform google or google_ads: no pre-set button. Set fix_kit.button_cta = "" and fix_kit.button_cta_reason = "". Use only fix_kit.ctas.`;

  const userPrompt = `Analyze this ad${hasAnyLandingContent ? ' AND its landing page' : ''} for ICP: "${icpDescription}"

Platform: ${platform}
Offer: ${offerType}
Landing Page URL: ${landingUrl || 'Not provided'}
Landing page content available: ${hasAnyLandingContent ? 'YES — SCORE IT 1-10' : 'NO — SCORE IT 0'}

${effectiveAdCopy ? (isAdvancedAudit ? `=== AD COPY (MULTI-VARIANT GOOGLE/PAID-ADS AUDIT — ${variants?.length || 0} variants) ===\n${effectiveAdCopy}\n\nNOTE: This is a structured Google Ads-style audit with multiple variants. Analyse the full ad structure: scoring should reflect the overall campaign quality across variants, and the 5 Ad Issues / Fix Kit / Experiments should cite specific headlines and descriptions (by variant + number) when relevant.` : `=== AD COPY ===\n${effectiveAdCopy}`) : '=== AD COPY ===\n[No ad copy provided]'}

${visualDescription ? `=== AD VISUAL DESCRIPTION ===\n${visualDescription}` : ''}
${adScreenshot ? `=== AD CREATIVE IMAGE ATTACHED ===\nThe actual ad creative image is attached to this message. READ the copy/text rendered ON the creative (headline, overlay text, CTA, captions) and analyze it as the ad's creative copy. Factor the creative copy AND its visual into the issues, especially headline_clarity, visual_copy_match, cta_friction and trust_signals, citing specific words shown on the creative.` : ''}

${landingPageContent ? `=== LANDING PAGE CONTENT (AUTO-SCRAPED FROM URL) ===\n${landingPageContent}` : ''}

${landingCopy?.trim() ? `=== LANDING PAGE CONTENT (USER-PROVIDED) ===\n${landingCopy}` : ''}

${!hasAnyLandingContent ? 'NO LANDING PAGE CONTENT AVAILABLE. Set all landing_page_roast scores to 0 and ad_landing_mismatch alignment_score to 0.' : 'LANDING PAGE CONTENT IS AVAILABLE ABOVE. You MUST provide real scores (1-10) for landing_page_roast and ad_landing_mismatch. Do NOT use 0.'}

Return the JSON object defined in the output contract. All fields required.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // Token optimization: cap output and turn OFF extended thinking. Sonnet 5 runs
        // adaptive thinking by DEFAULT when `thinking` is omitted, which silently adds
        // thinking tokens (billed at output rate) to every roast; this is a structured
        // JSON extraction, not a reasoning task, so disabling it is a direct saving.
        // With the brevity rules the JSON output is small, so 4000 is ample headroom.
        max_tokens: 4000,
        thinking: { type: 'disabled' },
        // Optimization #1 + #5: prompt-cache the large static system prompt AND the
        // JSON output contract together. Both are byte-identical across every roast,
        // so after the first call the whole prefix bills at ~0.1x (cache read) instead
        // of full input price. Moving the ~500-token schema out of the (uncached) user
        // message and into this cached prefix is the bulk of the per-roast saving.
        system: [{ type: 'text', text: systemPrompt + '\n\n' + OUTPUT_CONTRACT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: adScreenshot
          ? [{ type: 'text', text: userPrompt }, { type: 'image', source: { type: 'base64', media_type: (adScreenshotType || 'image/png'), data: adScreenshot } }]
          : userPrompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      /* Never leak the upstream provider error (billing, rate limits, model
         names) to the end user. Log the real one; show a neutral message. */
      console.error('[AdRoast] Upstream API error:', data.error.type, '-', data.error.message);
      return res.status(503).json({ error: "AdRoast is briefly unavailable. Please try again in a few minutes.", _meta: meta });
    }

    const modelText = Array.isArray(data.content)
      ? data.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
      : (data.content?.[0]?.text || '');
    if (modelText) {
      const jsonMatch = modelText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        console.log('[AdRoast] Meta:', JSON.stringify(meta));
        console.log('[AdRoast] hasAnyLandingContent:', hasAnyLandingContent);
        
        // Ensure landing_page_roast always exists
        if (!parsed.landing_page_roast) {
          parsed.landing_page_roast = {
            overall_score: hasAnyLandingContent ? 5 : 0,
            headline_score: hasAnyLandingContent ? 5 : 0,
            headline_feedback: hasAnyLandingContent ? 'Analysis could not be completed' : 'No landing page provided',
            value_prop_score: hasAnyLandingContent ? 5 : 0, value_prop_feedback: '',
            cta_score: hasAnyLandingContent ? 5 : 0, cta_feedback: '',
            trust_score: hasAnyLandingContent ? 5 : 0, trust_feedback: '',
            top_issues: [], quick_wins: []
          };
        }
        
        // Ensure ad_landing_mismatch always exists
        if (!parsed.ad_landing_mismatch) {
          parsed.ad_landing_mismatch = {
            alignment_score: hasAnyLandingContent ? 5 : 0,
            verdict: hasAnyLandingContent ? 'Analysis could not be completed' : 'No landing page provided for comparison',
            disconnects: [], message_match_issues: ''
          };
        }
        
        // FIX: If we HAVE landing content but LLM returned 0 scores, force minimum of 1
        // This is the main bug — LLM sometimes returns 0 even when content exists
        if (hasAnyLandingContent) {
          const lp = parsed.landing_page_roast;
          if (!lp.overall_score || lp.overall_score < 1) lp.overall_score = Math.max(1, lp.headline_score || 5);
          if (!lp.headline_score || lp.headline_score < 1) lp.headline_score = 5;
          if (!lp.value_prop_score || lp.value_prop_score < 1) lp.value_prop_score = 5;
          if (!lp.cta_score || lp.cta_score < 1) lp.cta_score = 5;
          if (!lp.trust_score || lp.trust_score < 1) lp.trust_score = 5;
          
          const mm = parsed.ad_landing_mismatch;
          if (!mm.alignment_score || mm.alignment_score < 1) mm.alignment_score = 5;
        }
        
        console.log('[AdRoast] LP score:', parsed.landing_page_roast.overall_score);
        console.log('[AdRoast] Match score:', parsed.ad_landing_mismatch.alignment_score);
        
        // Add meta for frontend debugging
        parsed._meta = meta;
        parsed._version = API_VERSION;

        /* Token consume + entitlement. We only reach here when `entitled` was true
           at the gate above (account has tokens, or Redis was down and we failed
           open). Consume one token for this successful roast, and cache the full
           result to roast:last so any out-of-token retry re-serves it — blurred —
           with no further Anthropic call (optimization #2). */
        if (acctEmail && !redisDown) {
          try {
            const t = await consumeToken(_redis, acctEmail);
            parsed._entitlement = { authed: true, email: acctEmail, full: t.full, remaining: t.remaining, plan: t.plan };
          } catch (e) {
            console.error('[AdRoast] consume error:', e.message);
            parsed._entitlement = { authed: true, email: acctEmail, full: true, remaining: null, plan: (acctBal && acctBal.plan) || null };
          }
          try { await _redis.set(`roast:last:${acctEmail}`, JSON.stringify(parsed), { ex: 60 * 60 * 24 * 30 }); } catch (e) {}
          // Cache this result under its input hash so an identical re-roast short-circuits
          // to the dedupe path above (no model call, no token spent). 7-day TTL.
          try { await _redis.set(dedupeKey, JSON.stringify(parsed), { ex: 60 * 60 * 24 * 7 }); } catch (e) {}
        } else {
          /* Fail-open path (Redis unavailable at the gate): serve the full roast,
             never blur — a transient outage must not block a paying user. */
          parsed._entitlement = { authed: !!acctEmail, email: acctEmail || null, full: true, remaining: null, plan: null };
        }

        return res.status(200).json(parsed);
      }
    }

    return res.status(502).json({ error: "We couldn't generate your roast just now. Please try again in a moment.", _meta: meta });
  } catch (error) {
    console.error('[AdRoast] Server error:', error && error.message);
    return res.status(500).json({ error: "Something went wrong generating your roast. Please try again in a moment.", _meta: meta });
  }
}
