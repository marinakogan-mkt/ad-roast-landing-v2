/**
 * Synthesis Report endpoint.
 *
 * POST /api/synthesize
 *   body: { roastLinks: ["https://adroast.in/?id=ABC", ...], clientName?: 'string' }
 *   1. Extracts the report ID from each link
 *   2. Fetches each roast's JSON via the same Notion lookup roast-view uses
 *   3. Sends the bundle to Claude with a synthesis prompt that mirrors Nudge's
 *      Evidence-Backed Audit Synthesis structure (A through I + Appendix + Final Diagnosis)
 *   4. Stores the resulting markdown in Upstash Redis under key `synth:<id>`
 *   5. Returns { id, markdown, sourceCount }
 *
 * GET /api/synthesize?id=<id>
 *   Returns the stored synthesis: { id, markdown, sourceLinks, createdAt }
 */

import { Redis } from '@upstash/redis';

const NOTION_DATABASE_ID = 'ca2dbc99d48c4ca8ab59375cf76d62cb';
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

function extractReportId(link) {
  try {
    const u = new URL(link);
    return u.searchParams.get('id') || null;
  } catch (e) {
    const m = (link || '').match(/[?&]id=([^&#]+)/);
    return m ? m[1] : null;
  }
}

async function fetchRoastFromNotion(id) {
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) throw new Error('NOTION_API_KEY missing');
  const queryRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({ filter: { property: 'Report ID', rich_text: { equals: id } } })
  });
  if (!queryRes.ok) throw new Error(`Notion query failed: HTTP ${queryRes.status}`);
  const queryData = await queryRes.json();
  if (!queryData.results || queryData.results.length === 0) throw new Error('Report not found');
  const pageId = queryData.results[0].id;
  const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    headers: { Authorization: `Bearer ${NOTION_API_KEY}`, 'Notion-Version': '2022-06-28' }
  });
  if (!blocksRes.ok) throw new Error('Notion blocks fetch failed');
  const blocksData = await blocksRes.json();
  let raw = '';
  for (const b of blocksData.results) {
    if (b.type === 'code' && b.code?.rich_text) {
      for (const t of b.code.rich_text) raw += t.plain_text || '';
    }
  }
  if (!raw) throw new Error('Report has no stored JSON');
  return JSON.parse(raw);
}

function randomId(n = 10) {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += alpha[Math.floor(Math.random() * alpha.length)];
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const id = (req.query?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
      const data = await redis.get(`synth:${id}`);
      if (!data) return res.status(404).json({ error: 'Synthesis not found' });
      return res.status(200).json(typeof data === 'string' ? JSON.parse(data) : data);
    } catch (e) {
      return res.status(500).json({ error: 'Lookup failed: ' + e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const roastLinks = Array.isArray(body.roastLinks) ? body.roastLinks.filter(s => (s || '').trim()) : [];
  const clientName = (body.clientName || '').trim() || 'Client';

  if (roastLinks.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 roast links to synthesize.' });
  }

  // Resolve each link → ID → roast JSON
  const fetched = [];
  const failures = [];
  for (let i = 0; i < roastLinks.length; i++) {
    const link = roastLinks[i];
    const id = extractReportId(link);
    if (!id) { failures.push({ link, error: 'No ?id= in link' }); continue; }
    try {
      const data = await fetchRoastFromNotion(id);
      fetched.push({ index: i + 1, link, id, data });
    } catch (e) {
      failures.push({ link, id, error: e.message });
    }
  }

  if (fetched.length < 2) {
    return res.status(400).json({
      error: 'Could not load enough roasts to synthesize (need at least 2).',
      failures
    });
  }

  // Build the synthesis prompt
  const auditBlocks = fetched.map((r, idx) => {
    const d = r.data;
    const result = d.result || d;
    return `=== AUDIT-${idx + 1} (source: ${r.link}) ===
ICP context: ${d.icp || d.icpDescription || '(not captured)'}
Platform: ${d.platform || '(unknown)'}

Ad Score: ${result.overall_score ?? 'n/a'}/10
Landing Page Score: ${result.landing_page_roast?.overall_score ?? 'n/a'}/10
Ad↔LP Match: ${result.ad_landing_mismatch?.alignment_score ?? 'n/a'}/10

ICP Mismatch / Audience: ${result.icp_mismatch || ''}

Ad Issues:
${(result.issues || []).map(i => `  • ${i.title} (${i.score}/10): ${i.explanation}`).join('\n')}

Landing Page:
  • Headline (${result.landing_page_roast?.headline_score}/10): ${result.landing_page_roast?.headline_feedback || ''}
  • Value Prop (${result.landing_page_roast?.value_prop_score}/10): ${result.landing_page_roast?.value_prop_feedback || ''}
  • CTA (${result.landing_page_roast?.cta_score}/10): ${result.landing_page_roast?.cta_feedback || ''}
  • Trust (${result.landing_page_roast?.trust_score}/10): ${result.landing_page_roast?.trust_feedback || ''}
  • Top issues: ${(result.landing_page_roast?.top_issues || []).join(' | ')}
  • Quick wins: ${(result.landing_page_roast?.quick_wins || []).join(' | ')}

Ad–LP Mismatch verdict: ${result.ad_landing_mismatch?.verdict || ''}
Disconnects:
${(result.ad_landing_mismatch?.disconnects || []).map(d => `  • Problem: ${d.problem}\n    Fix: ${d.fix}`).join('\n')}
Message-match issues: ${result.ad_landing_mismatch?.message_match_issues || ''}

Fix Kit:
  Headlines: ${(result.fix_kit?.headlines || []).join(' | ')}
  Body: ${result.fix_kit?.body || ''}
  CTAs: ${(result.fix_kit?.ctas || []).join(' | ')}
  LP Headline: ${result.fix_kit?.landing_page_headline || ''}
  LP Subhead: ${result.fix_kit?.landing_page_subhead || ''}
  Rationale: ${result.fix_kit?.rationale || ''}

Experiments:
${(result.experiments || []).map(e => `  • ${e.title}: ${e.description}`).join('\n')}

Next steps: ${(result.next_steps || []).join(' | ')}`;
  }).join('\n\n\n');

  const systemPrompt = `You are a senior B2B SaaS positioning consultant. The user provides you with multiple individual ad-audit reports (each one a single ad + landing page roast). Your job is to synthesize them into a strategic positioning report.

This is NOT a summary of each audit — it is a cross-audit synthesis that identifies recurring patterns, contradictions, positioning gaps, and consolidated GTM recommendations.

Return ONLY markdown. No preface, no closing. The markdown MUST follow this exact structure:

# ${clientName} — Evidence-Backed Audit Synthesis

## A) Executive Summary (Key Findings)
- 8–12 bulleted findings. Each starts with **Bold title.** then a sentence or two with evidence cited from the audits (e.g., "Trust scores average 3.4/10 across 5 ads"). The first line should be a callout headline insight (a strong opinion-led statement that names the #1 pattern).

## B) What the Audits Agree On (Patterns + Evidence)
For each of 4–6 patterns:
### Pattern N: Title
**Frequency:** X/Y audits. <one-line aggregate stat>
| Audit | <metric> | <metric> |
|---|---|---|
(table rows of audit-by-audit evidence)

**Evidence Snippets:**
> short verbatim quote from an audit (italic in markdown)
> source line

**Recommended Fix:** one sentence

## C) Inconsistencies & How to Resolve
For each of 2–4 contradictions:
### Contradiction N: Title
**The tension:** ...
**Resolution:** ...
**Recommendation:** ...

## D) Recommended Positioning
### Core Positioning Statement
One bolded sentence stating the positioning.
### Variant 1: Title (descriptor)
The positioning quoted in italic.
*Evidence: cite which audits scored well on this frame.*
### Variant 2: Title (descriptor)
...
### Variant 3: Title (descriptor)
...

## E) ICP & Segmentation
### Primary ICP (Who)
**Bold paragraph defining the ICP** based on patterns from the audits.
### Why Now (Trigger Events from Audits)
| Trigger | Evidence in audit |
|---|---|
(rows)
### Why ${clientName} (Differentiators from Audits)
| Differentiator | Evidence | Where it lives now |
|---|---|---|
(rows)
### Who to Exclude (from messaging)
| Persona | Why exclude |
|---|---|
(rows)

## F) Messaging Pillars + Proof Points
### Pillar 1: Title
**Message:** "..."
**Current State across the audits:** ...
**Proof needed:**
- bullet
- bullet
### Pillar 2: ...
(repeat for 3–4 pillars)

## G) Offer & CTA Direction
### Primary Offer (Test First Across All Audits)
**"..."** (the recommended primary CTA)
Evidence: short rationale.
### Recommended CTA Variants (per audit)
| Audit | Recommended primary CTA | Recommended secondary CTA |
|---|---|---|
### CTAs to Eliminate
| CTA | Why | Source |
|---|---|---|

## H) Do/Don't Messaging Rules
### DO (Evidence-Based)
| Rule | Evidence |
|---|---|
### DON'T (Evidence-Based)
| Rule | Evidence |
|---|---|

## I) Next 10 Actions (Prioritized) + 2-Week Testing Plan
### Immediate Actions (Week 1)
1. **Action title.** Description with audit citation. (Day 1)
2. **Action title.** ... (Day 2)
...
### Testing Actions (Week 2)
6. **A/B test ...** ...
...
### 2-Week Testing Plan Summary
| Day | Action | Source | Success Metric |
|---|---|---|---|

## Appendix: Audit Score Summary
| Audit | Ad Score | LP Score | Match | Top Issue |
|---|---|---|---|---|
(row per audit, plus an AVG row)

## Final Diagnosis
**The pattern is clear:** <one paragraph summarizing the central insight>.

The fix is not <X>. The fix is:
1. <step>
2. <step>
3. <step>
4. <step>

> short rallying-call quote

CRITICAL RULES:
- Cite specific audit evidence (e.g., "AUDIT-2 (the SCA ad) scored 8/10 while AUDIT-1 (SAST) only scored 5/10").
- Never invent numbers or quotes that aren't supported by the input audits.
- Treat the audits as a single body of evidence to extract patterns from.
- Output ONLY the markdown report. No JSON, no preamble, no closing message.`;

  const userPrompt = `Synthesize the following ${fetched.length} ad audits into a single Evidence-Backed Audit Synthesis report for ${clientName}.\n\n${auditBlocks}`;

  try {
    const llmRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    const llmData = await llmRes.json();
    if (llmData.error) {
      return res.status(500).json({ error: llmData.error.message || 'LLM error', failures });
    }
    const markdown = llmData.content?.[0]?.text || '';
    if (!markdown) return res.status(500).json({ error: 'Empty synthesis from LLM', failures });

    const id = randomId(10);
    const stored = {
      id,
      markdown,
      sourceLinks: fetched.map(f => f.link),
      clientName,
      createdAt: new Date().toISOString()
    };
    try {
      await redis.set(`synth:${id}`, JSON.stringify(stored));
    } catch (e) {
      // Storage failed — still return the markdown so the user gets something
      return res.status(200).json({
        success: true,
        markdown,
        id: null,
        storeError: e.message,
        sourceCount: fetched.length,
        failures
      });
    }
    return res.status(200).json({
      success: true,
      id,
      markdown,
      sourceCount: fetched.length,
      failures
    });
  } catch (e) {
    return res.status(500).json({ error: 'Synthesis failed: ' + e.message, failures });
  }
}
