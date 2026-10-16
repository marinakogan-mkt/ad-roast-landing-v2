// One-off: submit every URL in the live sitemaps to IndexNow, in batches of up to 10,000.
//   node scripts/indexnow-submit.mjs
// Python twin (for machines without node): gtm-flywheel-main/campaigns/geo/indexnow_submit.py
import { INDEXNOW_HOST, submitIndexNow } from '../api/_indexnow.js';

const base = 'https://' + INDEXNOW_HOST;
const robots = await (await fetch(base + '/robots.txt')).text();
let maps = [...robots.matchAll(/^Sitemap:\s*(\S+)/gim)].map(m => m[1]);
if (!maps.length) maps = [base + '/sitemap.xml', base + '/sitemap-boards.xml'];
const urls = new Set();
for (const m of maps) {
  const xml = await (await fetch(m)).text();
  for (const x of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const u = x[1].replace(/&amp;/g, '&');
    if (new URL(u).host === INDEXNOW_HOST) urls.add(u);
  }
}
const all = [...urls];
console.log(`${maps.length} sitemaps, ${all.length} urls`);
for (let i = 0; i < all.length; i += 10000) {
  const batch = all.slice(i, i + 10000);
  const status = await submitIndexNow(batch, 30000);
  console.log(`batch ${i / 10000 + 1}: ${batch.length} urls -> HTTP ${status}`);
}
