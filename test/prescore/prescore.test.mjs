// Batch pre-scoring: prepare must ship EXACTLY the live request, commit must leave the cache EXACTLY as
// the live scorer would have, and a board read afterwards must cost no Sonnet call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeAds, ICP, fakeRedis, installStubs, redactRequest, MODEL_TEXT_CLEAN, anthropicBody } from './harness.mjs';

const golden = JSON.parse(fs.readFileSync(new URL('./golden.json', import.meta.url), 'utf8')).clean;
const j = (x) => JSON.parse(JSON.stringify(x));
const scoreKeys = (writes) => writes.filter(w => w.key.startsWith('adscore:')).map(w => ({ key: w.key, val: JSON.parse(w.val), ex: w.ex })).sort((a, b) => a.key.localeCompare(b.key));
const sonnetCalls = (calls) => calls.filter(c => !/haiku/i.test(c.model)).length;

async function prepared(redis, ads = makeAds()) {
  const { prescorePrepare } = await import('../../api/_adlibrary.js');
  return prescorePrepare(ads, ICP, redis);
}
const answer = (prep, text = MODEL_TEXT_CLEAN) => Object.fromEntries(prep.requests.map(r => [r.custom_id, { texto: text, usage: anthropicBody(text).usage }]));

test('prepare ships the same request the live scorer sends', async () => {
  const stubs = installStubs();
  try {
    const prep = await prepared(fakeRedis());
    assert.equal(prep.ok, true);
    assert.equal(prep.need, 7);
    assert.equal(prep.requests.length, 1);
    assert.match(prep.jobId, /^[0-9a-f]{16}$/);
    assert.match(prep.requests[0].custom_id, /^[0-9a-f]{16}-0$/);
    assert.deepEqual(redactRequest(prep.requests[0].params), j(golden.anthropicRequest));
    assert.equal(sonnetCalls(stubs.anthropicCalls), 0, 'prepare must never call the model');
  } finally { stubs.restore(); }
});

test('commit writes the same score cache the live scorer writes, and the next board read is free', async () => {
  const stubs = installStubs();
  try {
    const { scoreAdsCached, prescoreCommit } = await import('../../api/_adlibrary.js');
    const redis = fakeRedis();
    const prep = await prepared(redis);
    const r = await prescoreCommit(prep.jobId, answer(prep), redis);
    assert.deepEqual({ ok: r.ok, written: r.written, failed: r.failed }, { ok: true, written: 7, failed: [] });
    assert.deepEqual(scoreKeys(redis.writes), scoreKeys(golden.writes));
    assert.equal(sonnetCalls(stubs.anthropicCalls), 0);
    const board = await scoreAdsCached(makeAds(), ICP, redis, { force: false, limit: 0 });
    assert.equal(sonnetCalls(stubs.anthropicCalls), 0, 'a board read after the batch must be a pure cache hit');
    assert.deepEqual(j(board.ads), j(golden.result.ads));
  } finally { stubs.restore(); }
});

test('commit never overwrites a score that already exists, and a job commits once', async () => {
  const stubs = installStubs();
  try {
    const { prescoreCommit, scoreKeyFn } = await import('../../api/_adlibrary.js');
    const redis = fakeRedis();
    const prep = await prepared(redis);
    const keyOf = scoreKeyFn(ICP);
    const live = JSON.stringify({ score: 9, verdict: 'live', tags: [], title: 'x', job: 'demand_gen', dims: {}, fit: true });
    await redis.set(keyOf(makeAds()[0]), live, { ex: 100 }); // a person opened the board while the batch ran
    const r = await prescoreCommit(prep.jobId, answer(prep), redis);
    assert.equal(r.alreadyThere, 1);
    assert.equal(redis.store.get(keyOf(makeAds()[0])), live);
    assert.deepEqual(await prescoreCommit(prep.jobId, answer(prep), redis), { ok: false, reason: 'job_expired_or_done' });
  } finally { stubs.restore(); }
});

test('a missing or unparseable answer leaves those creatives as plain cache misses', async () => {
  const stubs = installStubs();
  try {
    const { prescoreCommit, prescorePrepare } = await import('../../api/_adlibrary.js');
    const redis = fakeRedis();
    const prep = await prescorePrepare(makeAds(), ICP, redis, { perRequest: 3 });
    assert.equal(prep.requests.length, 3);
    const [a, b] = prep.requests;
    const results = { [a.custom_id]: { texto: 'sorry, no json here', usage: {} } }; // b and the third are missing
    const r = await prescoreCommit(prep.jobId, results, redis);
    assert.equal(r.failed.length, 1);
    assert.equal(r.skipped, 4);
    assert.equal(r.written, 0);
    assert.equal(scoreKeys(redis.writes).length, 0);
    assert.ok(b);
  } finally { stubs.restore(); }
});

test('already-cached creatives are not sent again, and an empty need makes no job', async () => {
  const stubs = installStubs();
  try {
    const { prescoreCommit } = await import('../../api/_adlibrary.js');
    const redis = fakeRedis();
    const prep = await prepared(redis);
    await prescoreCommit(prep.jobId, answer(prep), redis);
    const again = await prepared(redis);
    assert.deepEqual({ ok: again.ok, need: again.need, jobId: again.jobId, n: again.requests.length }, { ok: true, need: 0, jobId: null, n: 0 });
  } finally { stubs.restore(); }
});

test('no ICP, no pre-score', async () => {
  const stubs = installStubs();
  try {
    const { prescorePrepare } = await import('../../api/_adlibrary.js');
    assert.equal((await prescorePrepare(makeAds(), '', fakeRedis())).reason, 'no_icp');
    assert.equal((await prescorePrepare(makeAds(), 'Cannot be determined. The page is a domain parking page.', fakeRedis())).reason, 'no_icp');
  } finally { stubs.restore(); }
});

test('isAdminKey: only an ak_ key whose owner is a portal master', async () => {
  const { isAdminKey } = await import('../../api/_adminkey.js');
  const { PORTAL_ROLES } = await import('../../api/auth/_allowlist.js');
  const master = PORTAL_ROLES.find(r => r.mode === 'master').emails[0];
  const redis = fakeRedis({ 'roast:apikey:ak_admin1': master, 'roast:apikey:ak_user1': 'someone@example.com' });
  assert.equal(await isAdminKey({ headers: { authorization: 'Bearer ak_admin1' } }, redis), true);
  assert.equal(await isAdminKey({ headers: { 'x-api-key': 'ak_admin1' } }, redis), true);
  assert.equal(await isAdminKey({ headers: { 'x-api-key': 'ak_user1' } }, redis), false);
  assert.equal(await isAdminKey({ headers: { 'x-api-key': 'ak_nope' } }, redis), false);
  assert.equal(await isAdminKey({ headers: {} }, redis), false);
  assert.equal(await isAdminKey({ headers: { 'x-api-key': 'ak_admin1' } }, null), false);
});
