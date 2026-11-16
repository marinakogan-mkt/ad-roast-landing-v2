// Offline harness for the board scorer: a fake Redis, a stubbed fetch (Anthropic + creative images)
// and a recorded model response. Nothing here touches the network or a real key.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
import crypto from 'node:crypto';
// The golden file must not carry the scorer's system prompt (it is the product's rubric): keep a hash of it.
export function redactRequest(req) {
  const r = JSON.parse(JSON.stringify(req));
  r.system = (r.system || []).map(b => ({ ...b, text: 'sha256:' + crypto.createHash('sha256').update(String(b.text)).digest('hex') + ' len=' + String(b.text).length }));
  return r;
}
export const FROZEN_NOW = 1_800_000_000_000;

export const ICP = 'B2B cybersecurity buyers: CISOs and security directors at mid-market companies';

// Seven pulled ads covering every branch of the scorer's mapping.
export function makeAds() {
  return [
    { adId: 'li-100', plat: 'LinkedIn', advertiser: 'Acme Sec', head: 'Stop phishing before it lands', body: 'See how 300 security teams cut risk by 40%. Book a demo.', img: 'https://media.example.com/li-100.png' },
    { adId: 'g-200', plat: 'Google', advertiser: 'Acme Sec', head: '', body: '', img: 'https://tpc.example.com/g-200.png' },
    { adId: 'li-300', plat: 'LinkedIn', advertiser: 'Acme Sec', head: 'We are hiring a SOC analyst', body: 'Join our team in Austin.', img: 'https://media.example.com/li-300.png' },
    { adId: 'li-400', plat: 'LinkedIn', advertiser: 'Acme Sec', head: '4821937462', body: '', img: 'https://media.example.com/li-400.png' },
    { adId: 'li-500', plat: 'LinkedIn', advertiser: 'Acme Sec', head: 'Zero trust for the rest of us', body: 'A plain guide. Download it free.', img: 'https://media.example.com/li-500.png' },
    { adId: 'g-600', plat: 'Google', advertiser: 'Acme Sec', head: 'Endpoint protection pricing', body: 'Compare plans and start a trial today.', img: '' },
    { adId: 'li-700', plat: 'LinkedIn', advertiser: 'Acme Sec', head: 'Meet us at RSA booth 412', body: 'Come say hi.', img: '' },
  ];
}

// What the model "said" (clean JSON array). Index 4 is omitted on purpose (scorer skipped it).
export const MODEL_TEXT_CLEAN = JSON.stringify([
  { i: 0, score: 3, title: 'Stop phishing before it lands', verdict: 'Generic hook, proof is vague.', tags: ['Weak Hook', 'No Proof'], job: 'demand_gen', audience_kind: 'primary', audience: 'CISOs at mid-market firms', dims: { buyer_fit: 4, value: 3, proof: 2, offer_cta: 4 }, evidence: 'Book a demo' },
  { i: 1, textless: true, score: null, title: '', verdict: '', tags: [] },
  { i: 2, score: null, title: 'Hiring SOC analyst', verdict: '', tags: [], job: 'talent', audience_kind: 'secondary', audience: 'candidates', dims: {}, evidence: 'We are hiring' },
  { i: 3, score: 5, title: 'Capture issue', verdict: 'Capture issue on our side, not the advertiser\'s ad.', tags: [], flag: 'capture_fail' },
  { i: 5, score: 7, title: 'Endpoint protection pricing', verdict: 'Clear offer matched to query.', tags: ['Clear Offer', 'Strong CTA'], job: 'demand_gen', audience_kind: 'primary', audience: 'IT buyers', dims: { buyer_fit: 7, value: 7, offer_cta: 8 }, evidence: 'start a trial', head: 'Endpoint protection pricing', body: 'Compare plans and start a trial today.' },
  { i: 6, score: 6, title: 'Meet us at RSA', verdict: 'Event draw is thin, logistics clear.', tags: ['Thin Draw'], job: 'event', audience_kind: 'primary', audience: 'RSA attendees', dims: { draw: 5, logistics: 8, audience_fit: 6 }, evidence: 'booth 412' },
]);

// Same rows but with ONE unescaped quote, so JSON.parse fails and the salvage path runs.
export const MODEL_TEXT_BROKEN = MODEL_TEXT_CLEAN.replace('Generic hook, proof is vague.', 'Generic "hook", proof is vague.');

export function anthropicBody(text, usage = {}) {
  return { id: 'msg_test', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 5000, output_tokens: 800, cache_read_input_tokens: 2900, ...usage } };
}

export function fakeRedis(seed = {}) {
  const store = new Map(Object.entries(seed));
  const writes = [];
  return {
    store, writes,
    async mget(...keys) { return keys.map(k => (store.has(k) ? store.get(k) : null)); },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v, opts = {}) {
      if (opts.nx && store.has(k)) return null;
      store.set(k, v);
      writes.push({ key: k, val: v, ex: opts.ex || null, nx: !!opts.nx });
      return 'OK';
    },
    async del(...keys) { let n = 0; for (const k of keys) if (store.delete(k)) n++; return n; },
  };
}

// Install the stubs; returns {restore, anthropicCalls}.
export function installStubs({ modelText = MODEL_TEXT_CLEAN, haikuText = '[]' } = {}) {
  const realFetch = globalThis.fetch, realNow = Date.now, realLog = console.log, realErr = console.error;
  const anthropicCalls = [];
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  Date.now = () => FROZEN_NOW;
  console.log = () => {}; console.error = () => {};
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com/')) {
      const body = JSON.parse(init.body);
      anthropicCalls.push(body);
      const isHaiku = /haiku/i.test(body.model);
      return { ok: true, status: 200, json: async () => anthropicBody(isHaiku ? haikuText : modelText) };
    }
    // two creatives are "reachable" (a real 1x1 PNG, so they go to the model as base64 and the
    // textless / blind rules see an image); every other one is not -> the scorer sends its URL.
    if (/li-100|g-200/.test(u)) {
      return { ok: true, status: 200, headers: { get: (h) => (/content-type/i.test(h) ? 'image/png' : '') }, arrayBuffer: async () => PNG_1x1.buffer.slice(PNG_1x1.byteOffset, PNG_1x1.byteOffset + PNG_1x1.byteLength) };
    }
    return { ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { anthropicCalls, restore() { globalThis.fetch = realFetch; Date.now = realNow; console.log = realLog; console.error = realErr; } };
}
