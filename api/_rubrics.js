// AD TAXONOMY + PER-JOB RUBRICS (2026-10-29). ONE source of truth for how an ad is judged, shared by
// the board scorer (_adlibrary.js scoreAds + recheckLows) and the single-asset roast (roast.js), so
// the two can never drift apart again (they did: the board got PURPOSE BEFORE FIT a day before the
// roast). The design doc, with sources, is gtm-flywheel-main/reports/2026-10-29-adroast-taxonomia-ads.md.
//
// Three axes, kept separate on purpose:
//   1. JOB (what response the ad is built to get) picks the rubric below.
//   2. AUDIENCE (primary buyer, a deliberate secondary audience, an in-ICP segment, a local market)
//      changes WHO the rubric is judged against, never the rubric itself.
//   3. FORMAT (video, document, thought-leader, search) adds checks, never changes the job.
//
// Each job has 2 to 4 weighted DIMENSIONS. The model scores every dimension 1-10 and gives an
// overall; the code computes the weighted mean and keeps the overall within 1 point of it, so the
// number is explainable and stable, but the model can still separate a 2 from a 4 inside a band.
// This replaces the old hard floors (brand / secondary audience never below 5): an ad judged on its
// OWN job's dimensions needs no floor, and a genuinely bad brand ad can now score 3 for brand reasons.
// Underscore prefix = shared module, not a Vercel function (the project sits at the 12-function cap).

export const JOBS = {
  demand_gen: {
    label: 'Direct conversion', stage: 'conversion', conversion: true,
    signals: 'sells the product to the buyer now: a demo, trial, sign-up, pricing, quote, "book a call", a product benefit with a hard CTA',
    dims: [
      { k: 'buyer_fit', w: 0.30, q: 'speaks to the ICP buyer and a pain they actually have (the ONLY place buyer-fit is scored)' },
      { k: 'value', w: 0.25, q: 'a specific outcome or value proposition, not a category claim' },
      { k: 'proof', w: 0.20, q: 'in-ad proof: a named customer, a number, a logo, a real human. On Google search this lives on the landing page, so it is NOT scored there' },
      { k: 'offer_cta', w: 0.25, q: 'a clear offer and a CTA that fits the platform intent' },
    ],
    notAsked: 'nothing, this is the strict default rubric',
    cta: 'Request Demo, Sign Up, Get Quote, Start Now',
    fails: 'Wrong Buyer, Vague Value, No Proof, Weak CTA, Generic Hook',
  },
  lead_magnet: {
    label: 'Lead magnet', stage: 'conversion', conversion: true,
    signals: 'offers a GATED asset in exchange for contact details: an ebook, report, template, benchmark, checklist or toolkit behind a form (Download / Get the report, a native lead-gen form, a document ad that is gated)',
    dims: [
      { k: 'asset_value', w: 0.35, q: 'is the asset worth giving an email for: original data, a named framework, a specific outcome, not a generic ebook' },
      { k: 'relevance', w: 0.25, q: 'the asset is about a problem this product solves, for this buyer' },
      { k: 'preview', w: 0.20, q: 'tells what is inside: a teaser finding, a number, the chapters, so the reader knows what they get' },
      { k: 'friction', w: 0.20, q: 'the ask fits the value; a native form with 3-4 fields is the benchmark, every extra free-text field costs completions. Judge from what is visible, never invent a form' },
    ],
    notAsked: 'a demo, product proof or a product value proposition',
    cta: 'Download, Get the report, Get Quote',
    fails: 'Generic Asset, No Preview, Asset Off Problem, Costly Form',
  },
  content: {
    label: 'Content', stage: 'awareness', conversion: false,
    signals: 'promotes OPEN content with no form: a blog post, article, podcast, video episode, newsletter, a study or document shared freely, a point of view; Read / Listen / Watch / Learn More with no product offer. Thought-leader ads (fronted by a person) with no product offer land here',
    dims: [
      { k: 'in_feed_value', w: 0.30, q: 'the ad itself teaches or says something worth knowing, not just "read our latest post"' },
      { k: 'pov', w: 0.25, q: 'takes a specific position or shares a non-obvious finding, not consensus' },
      { k: 'bridge', w: 0.25, q: 'ties to a problem the product solves. Expectation depends on content_kind: product_led (a tutorial or workflow built on the product) needs a strong bridge; educational needs a reasonable bridge to the RIGHT product; search_traffic (captures a search query) only needs a light one' },
      { k: 'promise', w: 0.20, q: 'headline, body copy and destination (when known) promise the same thing; a headline about one topic with a body about another is the classic failure' },
    ],
    notAsked: 'a product value proposition, in-ad product proof, a demo or a hard CTA',
    cta: 'Learn More, Read, Listen, Watch, Subscribe',
    fails: 'Teaser Only, No POV, No Bridge, Split Promise',
  },
  brand: {
    label: 'Brand', stage: 'awareness', conversion: false,
    signals: 'builds memory, not a response: brand film, manifesto or mission, origin or founder story, a campaign line, an award or customer celebration, a past-event recap, a named content series with no offer. Most B2B buyers are not in market today, so this ad works by being remembered when they are',
    dims: [
      { k: 'fluency', w: 0.30, q: 'the brand is recognizable at a glance (for video, within the first seconds), through its own colors, characters, line or style, not just a small logo' },
      { k: 'single_idea', w: 0.25, q: 'one memorable idea, not three messages fighting' },
      { k: 'buyer_moment', w: 0.20, q: 'anchors the brand to a situation the buyer will be in when they need the category (a category entry point)' },
      { k: 'distinct', w: 0.25, q: 'distinctive and emotionally engaging; it could NOT run unchanged with a competitor\'s logo. Emotion builds preference in B2B, a feature list does not' },
    ],
    notAsked: 'a CTA, proof, a demo, a product value proposition or any conversion',
    cta: 'any or none',
    fails: 'Logo Swap, Late Branding, Mixed Messages, Forgettable',
  },
  social_proof: {
    label: 'Social proof', stage: 'consideration', conversion: false,
    signals: 'a customer story, testimonial, case study, review or rating (G2 badge, analyst mention) as the main message',
    dims: [
      { k: 'named_customer', w: 0.30, q: 'a customer the ICP recognizes or relates to, named, not "a leading company"' },
      { k: 'outcome', w: 0.35, q: 'a specific outcome with a number or a concrete before/after' },
      { k: 'story', w: 0.20, q: 'a real person and a situation the buyer sees themselves in' },
      { k: 'next_step', w: 0.15, q: 'an obvious next step (read the story, see how)' },
    ],
    notAsked: 'a generic product value proposition',
    cta: 'Learn More, Read the story',
    fails: 'Anonymous Customer, No Outcome, Quote Without Story',
  },
  launch: {
    label: 'Launch', stage: 'consideration', conversion: false,
    signals: 'announces something new: a feature, product, integration, release ("introducing", "new", "now available", "now with")',
    dims: [
      { k: 'what_changed', w: 0.35, q: 'says clearly WHAT is new' },
      { k: 'why_it_matters', w: 0.35, q: 'says why the buyer should care, an outcome, not "now with AI"' },
      { k: 'show_it', w: 0.15, q: 'shows it: a screenshot, an example, a demo frame' },
      { k: 'next_step', w: 0.15, q: 'a way to see or try it' },
    ],
    notAsked: 'the whole product story',
    cta: 'Learn More, See what is new, Sign Up',
    fails: 'Vague Launch, Feature Without Why, Nothing Shown',
  },
  comparison: {
    label: 'Comparison', stage: 'conversion', conversion: true,
    signals: 'bottom-funnel objection handling: "vs" a named rival, switching or migration, "alternative to", pricing transparency, ROI or TCO claims',
    dims: [
      { k: 'objection', w: 0.40, q: 'names a concrete objection or rival the buyer actually weighs' },
      { k: 'credibility', w: 0.30, q: 'the claim is specific, fair and backed, not a cheap shot' },
      { k: 'cta', w: 0.30, q: 'a bottom-funnel CTA that fits (compare, switch, migrate, see pricing)' },
    ],
    notAsked: 'category education',
    cta: 'Learn More, Get Quote, Sign Up',
    fails: 'Unnamed Rival, Unbacked Claim, Weak CTA',
  },
  event: {
    label: 'Event', stage: 'consideration', conversion: false,
    signals: 'presence at an UPCOMING event: a conference or trade show, a booth or stand, "meet us at", a city with a date, a webinar / roundtable / panel / live session, a speaking slot. A PAST event recap is brand, not event',
    dims: [
      { k: 'draw', w: 0.55, q: 'a concrete reason to show up tied to the buyer\'s pain: a talk, a demo, a named speaker, a meeting slot, an exclusive' },
      { k: 'logistics', w: 0.45, q: 'the essentials: which event, when, where or booth, how to engage' },
    ],
    notAsked: 'a product value proposition, in-ad proof, product-capability detail or a demo/sign-up CTA',
    cta: 'Register, Attend, Learn More',
    fails: 'No Reason To Meet, Venue Only, No Logistics',
  },
  talent: {
    label: 'Hiring / employer brand', stage: 'talent', conversion: false, unscored: true,
    signals: 'speaks to CANDIDATES, not buyers: we are hiring, open roles, life at the company, culture or team posts aimed at recruiting',
    dims: [],
    notAsked: 'everything, it is not a marketing ad to buyers and is not scored',
    cta: 'Apply',
    fails: '',
  },
};

export const JOB_KEYS = Object.keys(JOBS);
export const CONVERSION_JOBS = JOB_KEYS.filter(k => JOBS[k].conversion);
export const CONTENT_KINDS = ['product_led', 'educational', 'search_traffic'];

// Older cached rows (scorer v19 and the roast p6) used audience-ish job names. Map them onto the
// taxonomy so the board, the gate and the UI read one vocabulary. secondary_audience / segment /
// localized are AUDIENCE, not jobs: a product pitch to an enterprise buyer is still direct conversion.
export function normalizeJob(j) {
  const s = String(j || '').toLowerCase().trim();
  if (JOBS[s]) return s;
  if (/^(secondary_audience|segment|localized|demand|direct|conversion)/.test(s)) return 'demand_gen';
  if (/lead|gated|magnet/.test(s)) return 'lead_magnet';
  if (/content|blog|thought|article|podcast/.test(s)) return 'content';
  if (/hiring|talent|recruit|employer/.test(s)) return 'talent';
  if (/brand|culture|awareness/.test(s)) return 'brand';
  if (/event|webinar|conference/.test(s)) return 'event';
  return 'demand_gen'; // unknown => the strict default, never a softer rubric by accident
}

export const isConversionJob = (j) => !!(JOBS[normalizeJob(j)] || {}).conversion;

// Google search ads carry no in-ad proof by design (it lives on the landing page), so the proof
// dimension is dropped there and its weight spread over the rest.
function activeDims(job, plat) {
  const dims = (JOBS[job] || JOBS.demand_gen).dims;
  if (/google/i.test(String(plat || '')) && job === 'demand_gen') return dims.filter(d => d.k !== 'proof');
  return dims;
}

// Final 1-10 score from the dimension scores. `overall` is the model's own holistic number; it is
// kept when it sits within 1 point of the weighted mean (so a 2 vs a 4 inside a band survives), and
// pulled back to that range when it does not (so the number always follows the breakdown). With no
// usable dimensions it falls back to the overall. Returns null for unscored jobs (talent).
export function scoreFromDims(job, dims, overall, plat) {
  const j = normalizeJob(job);
  if (JOBS[j].unscored) return null;
  const ov = Number(overall);
  const act = activeDims(j, plat);
  let sw = 0, sv = 0;
  for (const d of act) {
    const v = Number(dims && dims[d.k]);
    if (!Number.isFinite(v)) continue;
    sw += d.w; sv += d.w * Math.min(10, Math.max(1, v));
  }
  if (!sw) return Number.isFinite(ov) ? Math.min(10, Math.max(1, Math.round(ov))) : null;
  const mean = sv / sw;
  const s = Number.isFinite(ov) ? Math.min(mean + 1, Math.max(mean - 1, ov)) : mean;
  return Math.min(10, Math.max(1, Math.round(s)));
}

// Keep only the dimension keys of the ad's job, as integers 1-10 (what the board caches and the UI shows).
export function cleanDims(job, dims, plat) {
  const out = {};
  for (const d of activeDims(normalizeJob(job), plat)) {
    const v = Number(dims && dims[d.k]);
    if (Number.isFinite(v)) out[d.k] = Math.min(10, Math.max(1, Math.round(v)));
  }
  return out;
}

// The rubric as prompt text, generated from JOBS so the prompt and the scoring code can never disagree.
export function rubricPrompt() {
  const rows = JOB_KEYS.map(k => {
    const j = JOBS[k];
    if (j.unscored) return `- ${k} (${j.label}): ${j.signals}. NOT SCORED: return score null and dims {}.`;
    const dims = j.dims.map(d => `${d.k} (${Math.round(d.w * 100)}%): ${d.q}`).join('; ');
    return `- ${k} (${j.label}, ${j.stage}): detect when it ${j.signals}. DIMENSIONS: ${dims}. NEVER dock it for lacking: ${j.notAsked}. Right CTA: ${j.cta}. Typical failure tags: ${j.fails}.`;
  }).join('\n');
  return `AD TAXONOMY (decide the JOB first, then judge the ad ONLY on that job's dimensions). Every ad has exactly one job from this list:
${rows}
HOW TO CLASSIFY: use three signals together, (1) the ad's own words and CTA, (2) its format (a document ad, a person-fronted thought-leader ad, a video), (3) where it sends the reader when known (a /blog or /resources URL, a form, a pricing or demo page, the homepage). A gated document is lead_magnet, a free one is content. A thought-leader ad (fronted by a person) is content or brand unless it carries an explicit product offer: LinkedIn only runs them for awareness and engagement. For content, also set content_kind: product_led (a tutorial or workflow where the product is the backbone), educational (teaches a topic, the product is a side mention), or search_traffic (built to capture a search query).
AUDIENCE is a separate axis: primary (the ICP buyer), secondary (a deliberate enterprise tier, partner / reseller / agency program, white-label or embedded offer, developer or API ecosystem), segment (one in-ICP industry or role), or localized (another language or market). Judge every dimension against the ad's OWN audience. A coherent secondary-audience, segment or localized ad is never docked for not being the homepage buyer; buyer_fit for it means fit to THAT audience.
FORMAT CHECKS (add to the job, never replace it): VIDEO, judge the opening seconds (attract), how early the brand shows (brand), story or emotion (connect) and the next step (direct); when only a still thumbnail is available, judge the copy and do not penalize the frame. DOCUMENT, the cover must hook on its own. THOUGHT-LEADER, it must sound like the person, not a press release.
GUARDRAILS: (a) any job other than demand_gen REQUIRES a positive signal quoted in evidence, never a charitable guess; (b) with no such signal, or when unsure, the job is demand_gen and it is judged strictly, so a vague ad to the right buyer still scores 1-4; (c) a different job changes the RUBRIC, not immunity: an ad that does its OWN job badly scores low, and a 1-4 must name the failing dimension in the verdict; (d) there are NO floors: a forgettable brand ad scores low for brand reasons, never for lacking a demo.`;
}
