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
