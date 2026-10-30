/* Platform format and policy rules for the roaster, as data. platformRulesPrompt() renders
   them into the system prompt in api/roast.js, and RULES_VERSION goes in the dedupe hash, so
   a rule change reaches repeat roasts without touching PROMPT_VERSION.
   The JSON between the markers is rewritten by scripts/refresh_platform_rules.py, which
   checks the Google and LinkedIn spec pages once a month: keep it strict JSON. To change the
   wording of a rule, edit "prompt" by hand; "{google.headline}" style tokens read "limits". */
const RULES = /*RULES-JSON-START*/{
  "version": "2026-10-30",
  "limits": {
    "google": {
      "headline": 30,
      "description": 90,
      "display_path": 15
    },
    "linkedin": {
      "intro_max": 3000,
      "headline_max": 200,
      "description_max": 300,
      "intro_truncate": 150,
      "headline_truncate": 70,
      "description_truncate": 100,
      "emoji_max": 10
    }
  },
  "prompt": [
    "PLATFORM FORMAT & POLICY RISK (fill the policy_flags array; this is SEPARATE from the quality scores above): check the ad against the CURRENT platform's hard limits and editorial/content policies and list every real compliance or format risk in policy_flags. These answer \"would this ad be rejected, disapproved or cut off\", NOT how good the ad is, so they never change the issue scores; a clean ad returns policy_flags: []. The opposite rule also holds: never let a format FACT (listed below) become an issue or lower a score.",
    "- GOOGLE SEARCH (RSA): HARD char limits = a headline over {google.headline} chars, a description over {google.description}, or a display path over {google.display_path} (rejected / will not save; spaces, punctuation and symbols all count, and CJK double-width characters count as 2). HARD editorial (disapproval risk): gimmicky or ALL-CAPS / MiXeD-case capitalization (allowed: trademarks, accepted abbreviations like ASAP); punctuation or symbol misuse, repeated \"!\", invalid characters; omitted, extra or gimmicky spacing (s p a c e d-out letters); gimmicky repetition of a word or phrase (including the same text repeated across the ad's assets); a phone number in the ad text (belongs in a call extension); non-standard spelling or grammar, or copy that does not make sense; not naming the business or product promoted.",
    "- LINKEDIN SINGLE IMAGE: HARD char limits = intro over {linkedin.intro_max}, headline over {linkedin.headline_max}, or description over {linkedin.description_max} (hard-cut). SOFT (truncation, the buyer never sees the tail) = intro over {linkedin.intro_truncate} (\"see more\" cutoff), headline over {linkedin.headline_truncate}, or description over {linkedin.description_truncate}. HARD policy: breaking the Professional Community Policies or a prohibited category (illegal products, drugs, adult, counterfeit, gambling or sweepstakes, political, affiliate, weapons, misleading health or weight-loss, unsafe behavior); misinformation or an unsupported claim; implied affiliation or endorsement without permission; a shortened or vanity URL in the link; a third-party trademark without authorization; non-standard formatting (excessive emojis beyond ~{linkedin.emoji_max}, excessive capitalization except valid acronyms, unrelated hashtags); clickbait or aggressive sales language (LinkedIn enforces a professional tone strictly).",
    "- TRADEMARK (both platforms): a DIRECT COMPETITOR using a rival's registered name in the ad TEXT is restricted (complaint-triggered disapproval): flag it, type trademark. NEVER a fault, never flag: the rival as a keyword, in the display-URL domain, or anywhere on the landing page. Exception: a reseller, an informational or comparison site, or a maker/seller of compatible components MAY name the mark in ad text when the landing page is primarily about those products, so weigh the advertiser type and the LP before flagging.",
    "- FORMAT FACTS, never score as a fault and never put in policy_flags: a Google RSA serving with as few as 1 headline + 1 description, or assets not showing or copy trimmed (normal, never \"missing headline / CTA\"); a Google search ad having no image; a LinkedIn description showing only in some placements; a LinkedIn in-text URL over 23 chars auto-converting to a LinkedIn short link (the platform does this, it is NOT a shortened-URL violation); a LinkedIn image serving as a thumbnail under 401px.",
    "- VISUAL-COPY MATCH on Google: for a Google SEARCH ad this dimension is headline-to-description-to-path coherence, never a visual. It stays that way EVEN when the ad arrives as a text-rendered search-result CARD image (a screenshot of the search result): that card IS the text ad, not a visual creative, so never score it \"no product shot\", \"just text\", or \"static card\", and never dock it for lacking imagery. Only a true Google Display or Demand Gen banner (real photography, illustration or product imagery) has a visual creative to score."
  ]
}/*RULES-JSON-END*/;

export const RULES_VERSION = RULES.version;

export function platformRulesPrompt() {
  return RULES.prompt.join('\n').replace(/\{(\w+)\.(\w+)\}/g, (_, platform, key) => RULES.limits[platform][key]);
}
