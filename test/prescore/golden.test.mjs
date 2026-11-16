// The refactor of scoreAds / scoreAdsCached must not change what the live board does.
// golden.json was captured from the ORIGINAL code (before the split into buildScoreRequest /
// parseScoreText / loadScoreCache / scoredRowsToEntries) with capture-golden.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeAds, ICP, fakeRedis, installStubs, redactRequest, MODEL_TEXT_CLEAN, MODEL_TEXT_BROKEN } from './harness.mjs';

const golden = JSON.parse(fs.readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
const j = (x) => JSON.parse(JSON.stringify(x));

for (const [name, text] of [['clean', MODEL_TEXT_CLEAN], ['broken', MODEL_TEXT_BROKEN]]) {
  test(`scoreAdsCached output, Redis writes and Anthropic request are unchanged (${name} model text)`, async () => {
    const stubs = installStubs({ modelText: text });
    try {
      const { scoreAdsCached } = await import('../../api/_adlibrary.js');
      const redis = fakeRedis();
      const r = await scoreAdsCached(makeAds(), ICP, redis, { force: false, limit: 0 });
      const calls1 = stubs.anthropicCalls.length;
      const r2 = await scoreAdsCached(makeAds(), ICP, redis, { force: false, limit: 0 });
      const g = golden[name];
      assert.deepEqual(j(r), j(g.result));
      assert.deepEqual(j(redis.writes), j(g.writes));
      assert.equal(stubs.anthropicCalls.length - calls1, g.secondPassNewCalls);
      assert.deepEqual({ scoredNew: r2.scoredNew, reused: r2.reused, pending: r2.pending }, g.second);
      assert.deepEqual(redactRequest(stubs.anthropicCalls[0]), j(g.anthropicRequest));
    } finally { stubs.restore(); }
  });
}
