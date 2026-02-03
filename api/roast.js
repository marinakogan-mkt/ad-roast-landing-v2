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

  const { platform, offerType, icpDescription, landingUrl, adCopy, visualDescription, hasImage, landingCopy } = body;

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
    landingScrapeError: null
  };

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
      landingPageContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
      
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

  const systemPrompt = `You are AdRoast, a brutally honest ad and landing page analyst for SaaS founders.

Your job:
1. Analyze whether the AD speaks to the user's stated ICP
2. If landing page content is provided: Analyze the LANDING PAGE for conversion issues
3. If both ad AND landing page exist: Identify MESSAGING MISMATCH between them

Approach: Direct, sarcastic but not mean. Use the "barbecue test" - would this copy make sense at a casual BBQ? Cite specific copy from both ad AND landing page when critiquing. Be harsh but fair — most ads and pages deserve 4-6.

Scoring (1-10): 1-3 = Actively hurting conversions, 4-6 = Generic/forgettable, 7-8 = Solid, 9-10 = Best-in-class

CRITICAL RULES:
- Return ONLY valid JSON. No markdown. No backticks. No text before or after the JSON.
- ALWAYS include ALL sections: issues, landing_page_roast, ad_landing_mismatch, fix_kit, experiments, next_steps.
- If landing page content IS provided, landing_page_roast and ad_landing_mismatch scores MUST be real numbers 1-10. NEVER 0 or null.
- If NO landing page content is provided, set landing_page_roast and ad_landing_mismatch scores to 0.`;

  const userPrompt = `Analyze this ad${hasAnyLandingContent ? ' AND its landing page' : ''} for ICP: "${icpDescription}"

Platform: ${platform}
Offer: ${offerType}
Landing Page URL: ${landingUrl || 'Not provided'}
Landing page content available: ${hasAnyLandingContent ? 'YES — SCORE IT 1-10' : 'NO — SCORE IT 0'}

${adCopy ? `=== AD COPY ===\n${adCopy}` : '=== AD COPY ===\n[No ad copy provided]'}

${visualDescription ? `=== AD VISUAL DESCRIPTION ===\n${visualDescription}` : ''}

${landingPageContent ? `=== LANDING PAGE CONTENT (AUTO-SCRAPED FROM URL) ===\n${landingPageContent}` : ''}

${landingCopy?.trim() ? `=== LANDING PAGE CONTENT (USER-PROVIDED) ===\n${landingCopy}` : ''}

${!hasAnyLandingContent ? 'NO LANDING PAGE CONTENT AVAILABLE. Set all landing_page_roast scores to 0 and ad_landing_mismatch alignment_score to 0.' : 'LANDING PAGE CONTENT IS AVAILABLE ABOVE. You MUST provide real scores (1-10) for landing_page_roast and ad_landing_mismatch. Do NOT use 0.'}

Return this EXACT JSON structure (all fields required):
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
    "overall_score": <${hasAnyLandingContent ? '1-10 REQUIRED — NOT 0' : '0'}>,
    "headline_score": <${hasAnyLandingContent ? '1-10' : '0'}>,
    "headline_feedback": "string",
    "value_prop_score": <${hasAnyLandingContent ? '1-10' : '0'}>,
    "value_prop_feedback": "string",
    "cta_score": <${hasAnyLandingContent ? '1-10' : '0'}>,
    "cta_feedback": "string",
    "trust_score": <${hasAnyLandingContent ? '1-10' : '0'}>,
    "trust_feedback": "string",
    "top_issues": ["string", "string", "string"],
    "quick_wins": ["string", "string", "string"]
  },
  "ad_landing_mismatch": {
    "alignment_score": <${hasAnyLandingContent ? '1-10 REQUIRED — NOT 0' : '0'}>,
    "verdict": "string",
    "disconnects": [{"problem": "string", "fix": "string"}],
    "message_match_issues": "string"
  },
  "fix_kit": {
    "headlines": ["string", "string", "string"],
    "body": "string",
    "ctas": ["string", "string"],
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
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message || 'API error', _meta: meta });
    }

    if (data.content?.[0]?.text) {
      const jsonMatch = data.content[0].text.match(/\{[\s\S]*\}/);
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
        return res.status(200).json(parsed);
      }
    }

    return res.status(500).json({ error: 'Could not parse response', _meta: meta });
  } catch (error) {
    return res.status(500).json({ error: 'Server error: ' + error.message, _meta: meta });
  }
}
