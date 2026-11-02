/* Single source of truth for the roast's PROMPT version, and the combined
   roast version string that stamps every saved report. Kept in its own tiny
   module (no heavy deps) so api/roast-view.js can import the version without
   pulling in roast.js's whole graph (ffmpeg, the ad-library scraper, etc.).

   PROMPT_VERSION is bumped whenever the scoring PROMPT changes in a way that
   should invalidate cached / stored roasts, so a prompt fix actually reaches
   old ads instead of re-serving a result scored under the old rules. It is part
   of the dedupe hash AND of the stored record.ver, so a stale report re-roasts
   on open (see api/roast-view.js) instead of showing the old-rules result.
     p2 (2026-10-05): LOCALIZATION hard rule + Visual-Copy Match gate for text ads.
     p3 (2026-10-19): PERSONALIZATION TOKENS hard rule, never roast unresolved merge
       tags (%FIRSTNAME%, {{company}}, etc.) from the ad library as a defect.
     p4 (2026-10-27): EVENT / PRESENCE AD LENS, judge event-presence ads by draw +
       logistics, not product-fit.
     p5 (2026-10-28): SECONDARY AUDIENCE / SUB-BRAND LENS, never score an enterprise /
       partner / white-label / developer ad as off-ICP against the homepage buyer.
     p6 (2026-10-29): PURPOSE BEFORE FIT parity with the board.
     p7 (2026-10-29): AD TAXONOMY (api/_rubrics.js, shared with the board).
     p8 (2026-10-30): PLATFORM FORMAT & POLICY RISK + policy_flags. The platform rules
       themselves live in api/_platform-rules.js with their own RULES_VERSION in the
       version string, so a rule update needs no bump here. */
import { RULES_VERSION } from './_platform-rules.js';

export const PROMPT_VERSION = 'p8';

// The version stamped on every roast record and compared on open. A mismatch
// (or a missing ver) means the stored roast predates the current prompt/rules
// and should be re-roasted against its frozen snapshot.
export function roastVer() {
  return `${PROMPT_VERSION}:${RULES_VERSION}`;
}
