// Run ONCE against the ORIGINAL scorer to record what scoreAdsCached returns and writes.
// node --import ./test/prescore/register.mjs test/prescore/capture-golden.mjs
import fs from 'node:fs';
import { makeAds, ICP, fakeRedis, installStubs, redactRequest, MODEL_TEXT_CLEAN, MODEL_TEXT_BROKEN } from './harness.mjs';

const out = {};
for (const [name, text] of [['clean', MODEL_TEXT_CLEAN], ['broken', MODEL_TEXT_BROKEN]]) {
  const stubs = installStubs({ modelText: text });
  try {
    const { scoreAdsCached } = await import('../../api/_adlibrary.js');
    const redis = fakeRedis();
    const r = await scoreAdsCached(makeAds(), ICP, redis, { force: false, limit: 0 });
    // second pass over the same redis: everything must now be a cache hit
    const calls1 = stubs.anthropicCalls.length;
    const r2 = await scoreAdsCached(makeAds(), ICP, redis, { force: false, limit: 0 });
    out[name] = { result: r, writes: redis.writes, secondPassNewCalls: stubs.anthropicCalls.length - calls1, second: { scoredNew: r2.scoredNew, reused: r2.reused, pending: r2.pending }, anthropicRequest: redactRequest(stubs.anthropicCalls[0]) };
  } finally { stubs.restore(); }
}
fs.writeFileSync(new URL('./golden.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('golden written', Object.keys(out));
