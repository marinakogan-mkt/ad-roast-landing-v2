/**
 * Server-side portal data. Lives here (api/_portal-data.js) so it is NEVER
 * shipped in the browser bundle. /api/portal-data returns only the slice the
 * authenticated user is allowed to see.
 *
 * Underscore prefix => Vercel treats this as a helper module, not a route.
 */

        export const portalData = {
            partners: {
                "fractional-demand": {
                    name: "Fractional Demand",
                    description: "Strategic consulting deliverables and campaign analysis for Fractional Demand partner engagements.",
                    clients: {
                        "nudge-security": {
                            name: "Nudge Security",
                            description: "Campaign audit analysis and strategic positioning recommendations",
                            positioning: {
                                title: "Evidence-Backed Audit Synthesis & Strategic Recommendations",
                                subtitle: "Positioning report based on 5 AdRoast audits + Call2 strategic direction",
                                summary: "Comprehensive analysis synthesizing all 5 ad campaign audits into actionable positioning, messaging pillars, ICP segmentation, CTA direction, and a prioritized 2-week testing plan for Nudge Security.",
                                content: {
                                    executiveSummary: "Ad-to-LP mismatch is the #1 conversion killer. Match scores average 5.6/10 across all audits. Every audit identifies tone shift, buried value props, or narrative discontinuity between ad and landing page.",
                                    keyFindings: [
                                        "Best ads (7/10) die on generic landing pages (4-6/10). AUDIT-5 has the strongest ad hook (\"CISO nightmare\") but the lowest LP match (4/10).",
                                        "Spend-focused messaging is fundamentally misaligned. AUDIT-3 scores 4/10 because \"both pieces are optimized for CFOs worried about budget, not CISOs worried about visibility.\"",
                                        "\"Day One visibility\" is the strongest value prop, and it is consistently buried. AUDIT-1, AUDIT-2, and AUDIT-5 all identify this as the key differentiator.",
                                        "CTAs are generic and friction-heavy. \"Learn more\" appears in multiple ads and is called \"the laziest CTA in B2B.\""
                                    ],
                                    recommendations: [
                                        "Create dedicated landing pages for each ad narrative. Do not send all traffic to one generic LP.",
                                        "Lead with Day One visibility as the hero headline on all landing pages.",
                                        "Replace all \"Learn more\" CTAs with action-oriented alternatives like \"Get my shadow inventory.\"",
                                        "Add trust signals (logos, testimonials, ratings) to ads targeting security professionals.",
                                        "Pause or deprioritize spend-focused ads. Reallocate budget to discovery-focused campaigns."
                                    ]
                                },
                                /* Full positioning report data. Lives server-side and is only served
                                   to authorized sessions (master / Fractional Demand) via /api/portal-data,
                                   so Nudge's report content never ships in the browser bundle. The portal
                                   renders this with the existing report layout — content + look unchanged. */
                                meta: {
                                    preparedFor: "Chris Godwin, Fractional Demand",
                                    date: "February 5, 2026",
                                    preparedBy: "Marina Kogan, Brands with Purpose"
                                },
                                report: {
                                    sectionA: {
                                        intro: { title: "Ad-to-LP mismatch is the #1 conversion killer.", desc: "Match scores average 5.6/10 across all audits. Every audit identifies tone shift, buried value props, or narrative discontinuity between ad and landing page." },
                                        findings: [
                                            { title: "Best ads (7/10) die on generic landing pages (4-6/10).", desc: "AUDIT-5 has the strongest ad hook (\"CISO nightmare\") but the lowest LP match (4/10). The compelling narrative evaporates on arrival." },
                                            { title: "Spend-focused messaging is fundamentally misaligned.", desc: "AUDIT-3 scores 4/10 on the ad because \"the fundamental issue is both pieces are optimized for CFOs worried about budget, not CISOs worried about visibility.\" This confirms Chris's direction to deprioritize spend." },
                                            { title: "\"Day One visibility\" is the strongest value prop, and it is consistently buried.", desc: "AUDIT-1, AUDIT-2, and AUDIT-5 all identify this as the key differentiator that gets lost between ad and LP." },
                                            { title: "CTAs are generic and friction-heavy.", desc: "\"Learn more\" appears in multiple ads and is called \"the laziest CTA in B2B\" (AUDIT-4). Action-oriented CTAs like \"See your hidden SaaS footprint\" consistently recommended." },
                                            { title: "Zero trust signals in ads targeting security professionals.", desc: "AUDIT-3, AUDIT-4 score 2-3/10 on trust signals. \"For IT security buyers evaluating a new vendor, this is table stakes\" (AUDIT-5)." },
                                            { title: "Landing page headlines lose ad momentum.", desc: "\"'See all the SaaS' is painfully generic\" (AUDIT-2). \"'Chaos to control' is bland startup speak\" (AUDIT-5). \"'SaaS Spend Management' doubles down on wrong value prop\" (AUDIT-3)." },
                                            { title: "The ICP is well-defined but messaging does not reflect it.", desc: "All audits use the same ICP definition, yet ads score 4-7/10 on actually speaking to that ICP's primary pain." },
                                            { title: "Tone inconsistency kills conversion.", desc: "\"Your ad's playful cat energy dies on a corporate landing page\" (AUDIT-1). \"Ad creates urgency... landing page feels like any other trial signup\" (AUDIT-5)." },
                                            { title: "Problem agitation works, but gets abandoned.", desc: "AUDIT-5's ad \"does brilliant problem agitation with specific, visceral language\" but \"the landing page greets them with generic copy.\"" }
                                        ]
                                    },
                                    sectionB: [
                                        {
                                            title: "Pattern 1: Ad-to-Landing Page Message Mismatch",
                                            frequency: "Frequency: 5/5 audits (100%)",
                                            table: { headers: ['Audit', 'Match Score', 'Core Problem'], rows: [
                                                ['AUDIT-1', '5/10', '"Ad\'s playful cat energy dies on corporate landing page"'],
                                                ['AUDIT-2', '6/10', '"Ad promises \'Day One visibility\'... landing page buries these key differentiators"'],
                                                ['AUDIT-3', '7/10', '"Decent consistency but wrong shared focus" (both wrong)'],
                                                ['AUDIT-4', '6/10', '"Ad undersells what the landing page delivers"'],
                                                ['AUDIT-5', '4/10', '"Major messaging disconnect... ad creates urgency... landing page feels generic"']
                                            ] },
                                            quotes: [
                                                { text: "The ad does brilliant problem agitation with specific, visceral language about tools 'I didn't approve'... but the landing page's 'chaos to control' headline could apply to literally any SaaS tool.", source: "AUDIT-5" },
                                                { text: "It's like promising a Ferrari and delivering a Honda.", source: "AUDIT-2" }
                                            ]
                                        },
                                        {
                                            title: "Pattern 2: Generic/Weak Landing Page Headlines",
                                            frequency: "Frequency: 5/5 audits (100%)",
                                            table: { headers: ['Audit', 'LP Headline Score', 'Critique'], rows: [
                                                ['AUDIT-1', '4/10', '"\'Secure Shadow SaaS\' sounds like vendor-speak"'],
                                                ['AUDIT-2', '4/10', '"\'See all the SaaS\' is painfully generic and sounds like a middle schooler wrote it"'],
                                                ['AUDIT-3', '5/10', '"\'SaaS Spend Management\' doubles down on wrong primary value prop"'],
                                                ['AUDIT-4', '6/10', '"Functional but lacks urgency"'],
                                                ['AUDIT-5', '4/10', '"\'Chaos to control in 14 days\' is bland startup speak"']
                                            ] },
                                            quotes: [
                                                { text: "Your ICP is feeling pressure from 'audits, security incidents, compliance reviews' - your headline should reflect that urgency, not sound like a productivity app.", source: "AUDIT-4" },
                                                { text: "After such a compelling ad about CISO nightmares, this is like being invited to an exciting party and arriving at a corporate webinar.", source: "AUDIT-5" }
                                            ]
                                        },
                                        {
                                            title: "Pattern 3: \"Day One Visibility\" Buried or Missing",
                                            frequency: "Frequency: 4/5 audits (80%)",
                                            quotes: [
                                                { text: "Ad emphasizes 'Day One visibility' as key benefit, landing page headline ignores this completely", source: "AUDIT-2 Problem #1" },
                                                { text: "Ad promises 'complete visibility from day one' but landing page buries this key benefit", source: "AUDIT-1 Problem #3" },
                                                { text: "'Find every SaaS app on Day One' is gold... why didn't that make it to the headline?", source: "AUDIT-2" }
                                            ],
                                            fix: { label: "Recommended Fix (consistent across audits):", text: "\"Make Day One visibility the hero headline on landing page\"" }
                                        },
                                        {
                                            title: "Pattern 4: Weak/Generic CTAs",
                                            frequency: "Frequency: 4/5 audits (80%)",
                                            table: { headers: ['Audit', 'CTA Score', 'Problem'], rows: [
                                                ['AUDIT-1', '5/10', '"\'Learn more\' is generic death"'],
                                                ['AUDIT-4', '5/10', '"\'Learn more\' is the laziest CTA in B2B"'],
                                                ['AUDIT-5', '6/10', '"\'See how you can get started today\' is generic LinkedIn speak"'],
                                                ['AUDIT-2', '8/10', 'Strong - "Find every SaaS account now"']
                                            ] },
                                            quotes: [
                                                { text: "Your ICP wants to 'regain SaaS visibility quickly' - so give them 'Get my SaaS inventory' not 'Learn more'", source: "AUDIT-4" },
                                                { text: "After such a compelling problem statement, you need an equally specific CTA like 'See your hidden SaaS footprint' or 'Discover what you're missing'", source: "AUDIT-5" }
                                            ]
                                        },
                                        {
                                            title: "Pattern 5: Missing Trust Signals in Ads",
                                            frequency: "Frequency: 4/5 audits (80%)",
                                            table: { headers: ['Audit', 'Trust Score', 'Issue'], rows: [
                                                ['AUDIT-1', '4/10', '"Zero social proof, logos, or credibility markers"'],
                                                ['AUDIT-3', '3/10', '"Zero trust signals in the ad"'],
                                                ['AUDIT-4', '2/10', '"Zero trust signals in a 15-word ad targeting security professionals"'],
                                                ['AUDIT-5', '5/10', '"\'Security leaders keep telling me\' is weak social proof"']
                                            ] },
                                            quotes: [
                                                { text: "IT teams are skeptical by nature - they need evidence this isn't another security vendor promising the moon.", source: "AUDIT-1" },
                                                { text: "For IT security buyers evaluating a new vendor, this is table stakes.", source: "AUDIT-5" }
                                            ]
                                        },
                                        {
                                            title: "Pattern 6: Spend Messaging = Wrong ICP",
                                            frequency: "Frequency: Explicit in 1 audit, implicit in 2 others",
                                            quotes: [
                                                { text: "Major disconnect. Your ICP's PRIMARY pain is 'lack visibility into apps employees are using' and 'cannot confidently answer which tools have access to company data.' This ad leads with cost savings - a secondary concern at best.", source: "AUDIT-3" },
                                                { text: "The fundamental issue is both pieces are optimized for CFOs worried about budget, not CISOs worried about visibility.", source: "AUDIT-3" },
                                                { text: "Feature list could prioritize security benefits over spend management", source: "AUDIT-4" }
                                            ]
                                        }
                                    ],
                                    sectionC: [
                                        { title: "Contradiction 1: Strong Ads vs. Weak Landing Pages", tension: "AUDIT-5 has ad score 7/10 but LP score 5/10 and match score 4/10. The ad works; the LP kills conversions.", resolution: "The problem is not ad quality, it is handoff. Strong ads need landing pages that continue their narrative, not generic trial pages.", rec: "Create dedicated landing pages for each ad narrative. Do not send all traffic to one generic LP." },
                                        { title: "Contradiction 2: Inventory Positioning (Primary vs. Secondary)", tension: "AUDIT-4 criticizes the ad for not emphasizing the \"free shadow SaaS inventory\" value, while AUDIT-3 says \"inventory\" is secondary to security/visibility.", resolution: "Inventory is the tangible artifact of discovery. When framed as \"proof you have a problem\" (security), it is primary. When framed as \"asset for management\" (ops), it is secondary.", rec: "Use \"inventory\" in CTAs tied to security outcomes: \"Get your free shadow inventory\" = good. Do not lead with inventory as an asset management benefit." },
                                        { title: "Contradiction 3: Tone (Playful vs. Serious)", tension: "AUDIT-1's cat metaphor worked (ad 7/10) but died on a corporate LP. AUDIT-4's \"lurking in shadows\" was called \"cheesy horror movie tagline\" (ad 3/10 on headline clarity).", resolution: "Playful works when it is relatable metaphor (cat chasing apps). It fails when it is theatrical (\"lurking in shadows\"). The key is authenticity to ICP experience.", rec: "Use relatable metaphors that IT teams actually use internally (\"chasing,\" \"drowning,\" \"blind spots\"). Avoid theatrical language that sounds like marketing." }
                                    ],
                                    sectionD: {
                                        corePositioning: "For IT and IT security teams at SaaS-heavy mid-market companies who cannot answer \"what apps have access to our data,\" Nudge Security delivers complete SaaS visibility on Day One, so you can stop reacting to shadow IT and start controlling it.",
                                        variants: [
                                            { label: "Variant 1: Problem-Led", tag: "Strongest for cold traffic", text: "\"You're responsible for data in tools you didn't approve, used by people you didn't train, for purposes you don't understand. Get complete visibility in 5 minutes.\"", evidence: "AUDIT-5 rates this problem framing 8/10 on headline clarity" },
                                            { label: "Variant 2: Outcome-Led", tag: "For aware buyers", text: "\"Day One visibility into every SaaS and AI app your employees are using, even the ones IT never approved.\"", evidence: "\"Day One visibility\" identified as key differentiator in AUDIT-1, AUDIT-2, AUDIT-5" },
                                            { label: "Variant 3: Proof-Led", tag: "For skeptical buyers", text: "\"Most companies discover 3x more SaaS apps than they thought. Find every app, user, and integration in 5 minutes, no agents, no network changes.\"", evidence: "AUDIT-2 recommends \"add specific results numbers like 'discover 10x more apps than traditional methods'\"" }
                                        ]
                                    },
                                    sectionE: {
                                        primaryICP: "IT and IT security teams (IT managers, IT security managers, SecOps leaders, and CISOs) at SaaS-heavy mid-market companies with 500-1,500 employees who lack visibility into the apps employees are using, cannot confidently answer which tools have access to company data, and feel growing pressure to regain SaaS visibility quickly before shadow IT, audits, or security incidents expose those gaps.",
                                        primaryICPBold: "IT and IT security teams (IT managers, IT security managers, SecOps leaders, and CISOs) at SaaS-heavy mid-market companies with 500-1,500 employees",
                                        icpNote: "Note: All 5 audits use this exact ICP definition as the benchmark for scoring.",
                                        whyNow: { headers: ['Trigger', 'Evidence'], rows: [
                                            ['Audit pressure', '"Before your next audit" - AUDIT-4 recommended headline'],
                                            ['Security incident fear', '"Shadow IT putting your audit at risk?" - AUDIT-4'],
                                            ['Compliance gaps', '"Before compliance gaps become security incidents" - AUDIT-4'],
                                            ['CISO accountability', '"I\'m responsible for data inside tools I didn\'t approve" - AUDIT-5']
                                        ] },
                                        whyNudge: { headers: ['Differentiator', 'Evidence'], rows: [
                                            ['Day One visibility', 'Cited in AUDIT-1, AUDIT-2, AUDIT-5 as key value prop'],
                                            ['No agents/network changes', '"Deploy in 5 minutes. No agents. No network changes" - AUDIT-5, 7/10 specificity'],
                                            ['Patented discovery', '"Patented discovery method adds differentiation" - AUDIT-2'],
                                            ['Collaborative governance', '"Collaborative governance vs traditional blocking" - AUDIT-5']
                                        ] },
                                        exclude: { headers: ['Persona', 'Why Exclude'], rows: [
                                            ['CFOs/Finance', '"Optimized for CFOs worried about budget, not CISOs worried about visibility" - AUDIT-3'],
                                            ['Data engineers', '"Not for data engineering workflows" - CHAT analysis'],
                                            ['Procurement', 'Secondary buyer, not primary pain owner']
                                        ] }
                                    },
                                    sectionF: [
                                        { num: 1, title: "Complete Discovery (Day One Visibility)", message: "\"See every SaaS and AI app on Day One, even the ones IT never approved.\"", state: "Buried or missing in 4/5 landing pages despite being the strongest differentiator.", proof: ["Average number of apps discovered per customer", "Time to complete discovery (minutes, not months)", "\"3x more apps than expected\" stat referenced in recommendations"] },
                                        { num: 2, title: "Security-First Visibility", message: "\"Know which apps have access to your data before attackers do.\"", state: "Diluted by spend messaging in AUDIT-3; generic in AUDIT-2.", proof: ["Types of risky integrations found (OAuth, MFA gaps)", "Customer quote about finding critical exposure", "\"Breach histories\" mentioned as ICP concern in AUDIT-2"] },
                                        { num: 3, title: "Fast, Frictionless Deployment", message: "\"5 minutes to complete visibility. No agents. No network changes.\"", state: "Strong when mentioned (AUDIT-5: 7/10 benefit specificity) but inconsistently emphasized.", proof: ["Exact deployment time benchmark", "Comparison to competitor deployment requirements", "\"No agents, no network changes\" already resonates, quantify it"] },
                                        { num: 4, title: "Audit/Compliance Readiness (Secondary)", message: "\"Stop shadow IT before your next audit.\"", state: "Recommended but not currently prominent in messaging.", proof: ["Compliance frameworks supported", "Time saved on audit prep", "Customer quote about audit confidence"] }
                                    ],
                                    sectionG: {
                                        primaryOffer: "\"Get your free shadow SaaS inventory\"",
                                        primaryOfferQuotes: [
                                            { text: "Get your free shadow SaaS inventory today is functional", source: "AUDIT-4 (LP 7/10)" },
                                            { text: "Your ICP wants to 'regain SaaS visibility quickly' - give them 'Get my SaaS inventory'", source: "AUDIT-4" }
                                        ],
                                        ctaVariants: { headers: ['Source', 'Recommended CTA'], rows: [
                                            ['AUDIT-1', '"Get my shadow inventory" / "See what I\'m missing"'],
                                            ['AUDIT-2', '"Get Day One visibility now" / "Find every hidden SaaS tool"'],
                                            ['AUDIT-3', '"See your complete SaaS inventory" / "Discover your hidden apps now"'],
                                            ['AUDIT-4', '"Start free security audit" / "Discover shadow apps now"'],
                                            ['AUDIT-5', '"See your hidden SaaS footprint" / "Discover what you can\'t see"']
                                        ] },
                                        ctaEliminate: { headers: ['CTA', 'Why', 'Source'], rows: [
                                            ['"Learn more"', '"Generic death" / "laziest CTA in B2B"', 'AUDIT-1, AUDIT-4'],
                                            ['"Start saving money today"', 'Wrong ICP pain', 'AUDIT-3'],
                                            ['"See how you can get started"', '"Generic LinkedIn speak"', 'AUDIT-5']
                                        ] }
                                    },
                                    sectionH: {
                                        do: { headers: ['Rule', 'Evidence'], rows: [
                                            ['Lead with Day One visibility', 'Recommended in AUDIT-1, AUDIT-2, AUDIT-5'],
                                            ['Use specific time claims ("5 minutes," "Day One")', '7/10+ on benefit specificity when used'],
                                            ['Match ad tone to landing page tone', 'Match scores drop 2+ points on tone shifts'],
                                            ['Name the problem before the solution', 'AUDIT-5 ad (problem-first) scores 8/10 on headline clarity'],
                                            ['Use action-oriented CTAs with specific benefits', '"Get my shadow inventory" vs "Learn more"'],
                                            ['Add trust signals (logos, testimonials, ratings)', '2-4/10 trust scores when missing']
                                        ] },
                                        dont: { headers: ['Rule', 'Evidence'], rows: [
                                            ['Do not lead with spend/cost savings', 'AUDIT-3 "Optimized for CFOs... not CISOs" (4/10 ad score)'],
                                            ['Do not use "Learn more" as CTA', 'Called "generic death" and "laziest CTA"'],
                                            ['Do not use theatrical language ("lurking in shadows")', 'AUDIT-4 3/10 headline clarity'],
                                            ['Do not shift from playful ad to corporate LP', 'AUDIT-1 "Cat energy dies on corporate landing page"'],
                                            ['Do not bury Day One visibility below fold', 'Identified as critical error in 4/5 audits'],
                                            ['Do not use generic headlines ("See all the SaaS," "Chaos to control")', '4-5/10 headline scores consistently']
                                        ] }
                                    },
                                    sectionI: {
                                        immediate: [
                                            { num: 1, day: "Day 1-2", title: "Rewrite LP headlines to match ad narratives", details: ["AUDIT-1 LP: \"Stop chasing shadow SaaS\" (carry metaphor forward)", "AUDIT-2 LP: \"Get Day One visibility into your entire SaaS estate\"", "AUDIT-5 LP: \"See every tool accessing your company data\""] },
                                            { num: 2, day: "Day 2", title: "Replace all \"Learn more\" CTAs", details: ["Swap to: \"Get my shadow inventory\" / \"See what I'm missing\" / \"Discover hidden apps now\""] },
                                            { num: 3, day: "Day 2", title: "Pause or deprioritize spend-focused ads", details: ["AUDIT-3 scores 4/10. Reallocate budget to discovery-focused ads (AUDIT-1, AUDIT-5 = 7/10)."] },
                                            { num: 4, day: "Day 3", title: "Add trust signals to ads", details: ["Include: Gartner rating, G2 score, or customer logo. Currently 2-4/10 on trust."] },
                                            { num: 5, day: "Day 3-5", title: "Create dedicated LPs for top-performing ad narratives", details: ["CISO nightmare ad: CISO-focused LP (problem-first)", "Cat metaphor ad: Relatable, conversational LP", "Stop current practice of sending all traffic to generic trial page"] }
                                        ],
                                        testing: [
                                            { num: 6, day: "Day 6-9", title: "A/B test Day One visibility headline", details: ["Test: \"Get Day One visibility into every SaaS app\" vs current headlines. Measure: bounce rate, conversion rate."] },
                                            { num: 7, day: "Day 6-9", title: "A/B test problem-first vs solution-first LP", details: ["AUDIT-5 recommends: \"Lead with 'Responsible for data in tools you can't see?'\" Test against current \"Chaos to control.\""] },
                                            { num: 8, day: "Day 8-10", title: "Test security-specific social proof", details: ["AUDIT-5: \"Test adding CISO testimonials and security team logos above the fold instead of generic customer stories.\""] },
                                            { num: 9, day: "Day 8-10", title: "Test urgency-driven headlines", details: ["AUDIT-2: \"Test 'Your shadow SaaS attack surface is growing right now' vs current headline to increase urgency.\""] },
                                            { num: 10, day: "Day 10-14", title: "Document baseline + results", details: ["Record: CTR by ad, conversion rate by LP, demo quality score. Compare against pre-optimization baseline."] }
                                        ],
                                        summary: { headers: ['Day', 'Action', 'Source', 'Success Metric'], rows: [
                                            ['1-2', 'Rewrite LP headlines', 'AUDIT-1,2,5 Fix Kits', 'Headlines live'],
                                            ['2', 'Replace "Learn more" CTAs', 'AUDIT-1,4', 'All CTAs updated'],
                                            ['2', 'Pause spend ads', 'AUDIT-3', 'Budget reallocated'],
                                            ['3', 'Add trust signals to ads', 'AUDIT-1,3,4', 'Trust score improvement'],
                                            ['3-5', 'Create dedicated LPs', 'All audits', 'LPs live'],
                                            ['6-9', 'A/B test Day One headline', 'AUDIT-2', 'Statistical significance'],
                                            ['6-9', 'A/B test problem-first LP', 'AUDIT-5', 'Conversion rate delta'],
                                            ['8-10', 'Test security social proof', 'AUDIT-5', 'Above-fold engagement'],
                                            ['8-10', 'Test urgency headlines', 'AUDIT-2', 'CTR improvement'],
                                            ['10-14', 'Document results', 'All', 'Baseline vs post data']
                                        ] }
                                    },
                                    appendix: {
                                        scores: { headers: ['Audit', 'Ad', 'LP', 'Match', 'Top Issue'], rows: [
                                            ['AUDIT-1', '7/10', '6/10', '5/10', 'Tone shift kills momentum'],
                                            ['AUDIT-2', '7/10', '6/10', '6/10', '"Day One" buried'],
                                            ['AUDIT-3', '4/10', '6/10', '7/10', 'Wrong ICP (spend vs security)'],
                                            ['AUDIT-4', '4/10', '7/10', '6/10', 'Ad undersells LP value'],
                                            ['AUDIT-5', '7/10', '5/10', '4/10', 'Best ad, worst handoff'],
                                            [{ bold: true, text: 'AVG' }, { bold: true, text: '5.8' }, { bold: true, text: '6.0' }, { bold: true, text: '5.6' }, { bold: true, text: 'Handoff is the gap' }]
                                        ] },
                                        finalDiagnosis: {
                                            lead: "Nudge Security has strong ad concepts (3 of 5 score 7/10) that die on generic landing pages (average 6/10) with poor message handoff (average 5.6/10).",
                                            fixTitle: "The fix is not new ads. The fix is:",
                                            fixes: ["1. Landing pages that continue ad narratives", "2. CTAs that match ICP urgency", "3. Trust signals for skeptical security buyers", "4. Day One visibility as the hero message everywhere"],
                                            quote: { text: "The ad creates urgency... the landing page feels like any other trial signup.", source: "AUDIT-5" },
                                            closing: "Stop creating urgency and then abandoning it. Carry the narrative through."
                                        },
                                        footer: ["Report prepared by Marina Kogan | Brands with Purpose", "Based on 5 AdRoast audits + Call2 strategic direction", "Confidential: For Chris Godwin / Fractional Demand use only"]
                                    }
                                }
                            },
                            audits: {
                                1: {
                                    title: "SaaS Sprawl Cat Meme Campaign Analysis",
                                    summary: "Audit of playful cat metaphor ad and shadow SaaS inventory landing page messaging alignment.",
                                    findings: "The playful cat energy works in the ad (7/10) but dies on a corporate landing page. Tone inconsistency kills conversion potential.",
                                    recommendations: "Carry the metaphor forward to the landing page. Use relatable language IT teams actually use internally.",
                                    auditUrl: "https://www.brandswithpurpose.us/?id=A45fRcsN",
                                    adUrl: "https://www.linkedin.com/ad-library/detail/1021588116",
                                    landingPageUrl: "https://www.nudgesecurity.com/try-nudge/free-shadow-saas-inventory?utm_medium=paid_social&utm_source=linkedin&utm_content=tof&utm_campaign=saas_sprawl&utm_term=meme_saas_sprawl_cat-laser-beam_og&trk=ad_library_ad_preview_headline_content"
                                },
                                2: {
                                    title: "SaaS Discovery Feature-Focused Campaign",
                                    summary: "Analysis of discovery-focused messaging and feature education landing page conversion potential.",
                                    findings: "Ad emphasizes 'Day One visibility' but landing page buries this key differentiator below the fold.",
                                    recommendations: "Make 'Day One visibility' the hero headline. Add specific results numbers like 'discover 3x more apps than expected.'",
                                    auditUrl: "https://www.brandswithpurpose.us/?id=zqTSNdfF",
                                    adUrl: "https://www.linkedin.com/ad-library/detail/856848906",
                                    landingPageUrl: "https://www.nudgesecurity.com/features/saas-discovery?utm_medium=paid_social&utm_source=linkedin&utm_content=mof&utm_campaign=saas_discovery&utm_term=image_find-every-saas-button&hsa_acc=509483795&hsa_cam=766701946&hsa_grp=414445406&hsa_ad=856848906&hsa_net=linkedin&hsa_ver=3&trk=ad_library_ad_preview_headline_content"
                                },
                                3: {
                                    title: "Spend Management Value Proposition Test",
                                    summary: "Evaluation of cost savings messaging versus security-first positioning for IT decision makers.",
                                    findings: "Major disconnect. ICP's primary pain is visibility, not cost. Both ad and LP are optimized for CFOs, not CISOs.",
                                    recommendations: "Deprioritize spend messaging. Focus on security outcomes and compliance readiness instead.",
                                    auditUrl: "https://www.brandswithpurpose.us/?id=gzvxQUzr",
                                    adUrl: "https://www.linkedin.com/ad-library/detail/744052366",
                                    landingPageUrl: "https://www.nudgesecurity.com/use-cases/saas-spend-management?utm_medium=paid_social&utm_source=linkedin&utm_content=mof&utm_campaign=saas_spend&utm_term=image_saas-spend-mgmt&hsa_acc=509483795&hsa_cam=766701946&hsa_grp=414445406&hsa_ad=744052366&hsa_net=linkedin&hsa_ver=3&trk=ad_library_ad_preview_headline_content"
                                },
                                4: {
                                    title: "Free Shadow Inventory Offer Campaign",
                                    summary: "Assessment of free inventory offer messaging and lead generation landing page effectiveness.",
                                    findings: "Strong offer but generic execution. Zero trust signals in a 15-word ad targeting security professionals.",
                                    recommendations: "Add credibility markers and security team logos. Make the inventory feel like proof of a problem, not just an asset.",
                                    auditUrl: "https://www.brandswithpurpose.us/?id=jeGGBXMg",
                                    adUrl: "https://www.linkedin.com/ad-library/detail/743863956",
                                    landingPageUrl: "https://www.nudgesecurity.com/free-shadow-saas-inventory?utm_medium=paid_social&utm_source=linkedin&utm_content=tof&utm_campaign=saas_discovery&utm_term=meme_shadowsaas_wrestling&trk=ad_library_ad_preview_headline_content"
                                },
                                5: {
                                    title: "CISO Nightmare Scenario Campaign",
                                    summary: "Analysis of fear-based messaging and security professional onboarding flow conversion.",
                                    findings: "Best ad (7/10) with brilliant problem agitation, but worst handoff (4/10). Compelling narrative evaporates on arrival.",
                                    recommendations: "Create a CISO-specific landing page that continues the nightmare scenario. Do not abandon the urgency.",
                                    auditUrl: "https://www.brandswithpurpose.us/?id=FSuv7GVr",
                                    adUrl: "https://www.linkedin.com/posts/russell-spitler_if-i-were-a-ciso-trying-to-secure-a-modern-activity-7422674209866158080-YpyX/?utm_source=share&utm_medium=member_desktop&rcm=ACoAAALZYHsBKlGcVjgVV6ogTBO7ymVFdwET_r4",
                                    landingPageUrl: "https://www.nudgesecurity.com/getting-started"
                                }
                            }
                        }
                    }
                }
            },
            directClients: {
                "aikido-security": {
                    name: "Aikido Security",
                    description: "Strategic ad audits and positioning across Aikido's paid campaigns.",
                    projects: {
                        "google-search-campaigns": {
                            name: "Google Search Campaigns",
                            description: "Campaign audit analysis and strategic positioning recommendations.",
                            platform: "Google",
                            positioning: {
                                title: "Evidence-Backed Audit Synthesis & Strategic Recommendations",
                                subtitle: "Positioning report based on 5 AdRoast audits (Google Search RSAs)",
                                /* Pull the actual content live from the synthesis store so the portal
                                   stays in sync with the public ?synth= URL. Regenerating updates both. */
                                synthId: "b3SLj6YwW4",
                                summary: "Comprehensive analysis synthesizing 5 ad audits into actionable positioning, messaging pillars, ICP definition, CTA direction, and a prioritized 2-week testing plan.",
                                content: {
                                    executiveSummary: "Trust signal absence is the biggest conversion blocker. Trust scores average 3.4/10 across 5 ads. Aikido has '50k+ orgs · 100k+ devs · 4.7/5' + 14 named customer logos + 6 testimonials sitting unused on every LP. None of those proof assets travel into the ad copy at the moment of click decision.",
                                    keyFindings: [
                                        "The SCA ad (AUDIT-2) is best-in-class at 8/10 with Google's Excellent rating. The other 4 ads sit at 4-7/10 with Average/Good/Limited Approved ratings. Same team, same brand, same product family. The variance is copy choices, not budget.",
                                        "AUDIT-4 (vs SonarQube) is Limited Approved by Google. Eligibility likely restores within 72 hours of dropping '#1 Alternative' and 'Did You Mistype Aikido?' headlines. The only same-week-ROI fix in the audit.",
                                        "Product-category fork: SAST, AI Code Review, and Code Quality used interchangeably. One positioning decision fixes 3 campaigns and 3 LP H1s.",
                                        "Trust numbers inconsistent across the brand: 10k+, 25k+, 50k+, 100k+ — four numbers on one journey. A buyer who clicks two of these spots the inconsistency and trusts both less.",
                                        "Specific LP numbers (95% noise reduction, 32-second scans, €3,500 flat pentest) never travel into the ads. The proof is locked on the LP, never moves to the moment of click decision."
                                    ],
                                    recommendations: [
                                        "Restore SonarQube ad approval (Day 1): drop '#1 Alternative' and 'Did You Mistype Aikido?' headlines. Limited Approved → Eligible within 72h.",
                                        "Promote SAST 95% noise reduction from headline slot 14 → slot 1 (sharpened from the diluted 85% currently in ad). Single largest free lift in the campaign.",
                                        "Standardize trust line to '50k+ orgs · 100k+ devs · 4.7/5' across all 5 ads. Stop reinventing the number per asset.",
                                        "Add one named-customer quote per ad: Konstantin S (SAST), Christian Schmidt (SCA), Dan Sherwood (AI Pentest), Salvatore Cuccurullo (vs SonarQube).",
                                        "Add one demo CTA per ad to open the enterprise procurement path currently invisible (AI Pentest €25K+, SonarQube replacement)."
                                    ]
                                }
                            },
                            audits: {
                                1: {
                                    title: "SAST Scanner Campaign",
                                    summary: "Audit of Aikido's SAST Google RSA targeting DevSecOps leads searching for static code analysis replacements (Snyk Code, Sonar, Semgrep).",
                                    findings: "The ad's strongest weapon — 95% false-positive reduction — is buried at headline slot 14 while 'Best SAST Worldwide' vendor noise fills the top. Zero trust signals in a sale to security buyers who've already been burned by Snyk.",
                                    recommendations: "Move the 95% number to headline slot 1 and name the competitor. Quote Konstantin S leaving Snyk in the ad where buyers can read it before they click, not after.",
                                    auditUrl: "https://www.adroast.in/?id=6Yba3yPp",
                                    adUrl: "https://adstransparency.google.com/advertiser/AR10178884492211519489?region=VN",
                                    liveAds: [
                                        { label: "SAST RSA", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR05205962441103507457" },
                                        { label: "Kotlin/Swift variant", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR02981050084763893761" },
                                        { label: "Alternate-headline variant", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR05790785529091981313" }
                                    ],
                                    landingPageUrl: "https://www.aikido.dev/code/sast-engine"
                                },
                                2: {
                                    title: "SCA Scanner Campaign",
                                    summary: "Audit of Aikido's SCA ad. The strongest in the campaign, rated Excellent by Google. Names the buyer in slot 1, uses pain-language, specific mechanism.",
                                    findings: "The model audit. Names the buyer in slot 1, uses pain-language, points to a specific mechanism — but undercounts its own trust line by 10x (ad: 10k+ teams vs LP: 100k+ devs).",
                                    recommendations: "Standardize the trust line to 100k+ devs. Pull Christian Schmidt's Snyk-migration quote into the ad. Treat this campaign as the template for the other four.",
                                    auditUrl: "https://www.adroast.in/?id=Gs6hNNTA",
                                    adUrl: "https://adstransparency.google.com/advertiser/AR10178884492211519489?region=VN",
                                    liveAds: [
                                        { label: "SCA RSA", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR03731046551120773121" }
                                    ],
                                    landingPageUrl: "https://www.aikido.dev/code/aikido-sca"
                                },
                                3: {
                                    title: "AI Pentest Campaign",
                                    summary: "Audit of Aikido's AI Pentest Google RSA. Carries the campaign's boldest unconventional positioning: '€3,500 flat. No findings = don't pay.'",
                                    findings: "'No findings = no pay' is the sharpest unconventional move in the audit, but five near-duplicate AI-Pentest headlines waste slots and the freemium-only CTAs disqualify the €25K procurement buyer this product is actually built for.",
                                    recommendations: "Keep the risk reversal. Drop three of the clone headlines. Quote Dan Sherwood on compliance and add one CISO demo CTA so the enterprise buyer has a path in.",
                                    auditUrl: "https://www.adroast.in/?id=zVNStrvS",
                                    adUrl: "https://adstransparency.google.com/advertiser/AR10178884492211519489?region=VN",
                                    liveAds: [
                                        { label: "AI Pentest RSA", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR15175644350546706433" },
                                        { label: "AU Pentesting (consolidated)", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR00078471191391633409" },
                                        { label: "Pentest variant 1", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR07773284158809309185" },
                                        { label: "Pentest variant 2", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR16434015754765991937" },
                                        { label: "Pentest variant 3", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR07567504922673938433" }
                                    ],
                                    landingPageUrl: "https://www.aikido.dev/attack/aipentest"
                                },
                                4: {
                                    title: "vs SonarQube Comparison Campaign",
                                    summary: "Audit of Aikido's competitor comparison ad targeting buyers searching for SonarQube alternatives. Currently Limited Approved by Google.",
                                    findings: "Limited Approved by Google over two policy-trigger headlines, plus a category collision — the ad sells AI Code Review while the LP sells AppSec. The LP's strongest pricing line (€3,240 vs €3,302) never makes it to the click decision.",
                                    recommendations: "Drop the two policy-trigger headlines — restores eligibility within 72h. Replace the AI Code Review filler with LP positioning. Quote Salvatore Cuccurullo's SonarQube migration and put the price-parity line in the ad.",
                                    auditUrl: "https://www.adroast.in/?id=C78UmgSD",
                                    adUrl: "https://adstransparency.google.com/advertiser/AR10178884492211519489?region=VN",
                                    liveAds: [
                                        { label: "SonarQube-alternative RSA", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR10473496150383001601" },
                                        { label: "\"Why Everyone's Leaving SonarQube\"", url: "https://adstransparency.google.com/advertiser/AR10178884492211519489/creative/CR07035098989955383297" }
                                    ],
                                    landingPageUrl: "https://www.aikido.dev/comparison/aikido-vs-sonarqube"
                                },
                                5: {
                                    title: "SBOM Generator Campaign",
                                    summary: "Audit of Aikido's SBOM Generator ad targeting compliance teams needing CycloneDX/SPDX SBOMs for SOC 2, ISO 27001, EO 14028, NIS2 deadlines.",
                                    findings: "Compliance product with zero compliance proof in the ad. Two of four description slots are empty (capping Ad Strength at Good) and the LP testimonial is from a Software Engineer — wrong rank for a buyer who signs off on SOC 2.",
                                    recommendations: "Fill the two empty description slots — cheapest fix in the audit. Surface SOC 2 + ISO 27001 + FedRAMP in the hero. Swap the Software Engineer testimonial for Konstantin S (Head of InfoSec) — the right rank for a CISO product.",
                                    auditUrl: "https://www.adroast.in/?id=ttdKdxxc",
                                    adUrl: "https://adstransparency.google.com/advertiser/AR10178884492211519489?region=VN",
                                    landingPageUrl: "https://www.aikido.dev/use-cases/sbom-generator-create-software-bill-of-materials"
                                }
                            }
                        }
                    }
                }
            }
        };
