/**
 * Shared token/credit accounting for roast-tool accounts (monetization #3).
 *
 * One roast costs one token. Plans:
 *   free     -> 1 token, one time (the free roast)
 *   monthly  -> 20 tokens, reset to 20 every 30-day cycle ($24/mo subscription)
 *   lifetime -> 20 tokens, reset to 20 every 30-day cycle, forever ($482 one-time)
 *
 * Monthly replenish is LAZY: we advance the cycle and refill on the next read,
 * so no Stripe webhook is required for the MVP. (Subscription cancellation is
 * not yet enforced here; a webhook can downgrade the plan later.)
 *
 * State lives in a single Redis key per account: roast:acct:<email> =
 *   { plan, tokens, cycleStart, created }
 *
 * This file is underscore-prefixed so Vercel treats it as a shared module, not
 * a serverless function (the project is at the 12-function Hobby cap).
 */

export const PLAN_TOKENS = { free: 1, monthly: 20, lifetime: 20 };
const CYCLE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/* Accounts with unlimited roasts (owner / internal). These never consume a
   token and always pass the entitlement gate, regardless of Redis state. */
const UNLIMITED_EMAILS = new Set(['marina.kogan@adroast.in']);
const UNLIMITED_BALANCE = 999999;

function normEmail(email) { return String(email || '').trim().toLowerCase(); }

async function readAccount(redis, email) {
  let raw = null;
  try { raw = await redis.get(`roast:acct:${email}`); } catch (e) { raw = null; }
  let acct = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  if (!acct || typeof acct !== 'object') {
    acct = { plan: 'free', tokens: PLAN_TOKENS.free, cycleStart: Date.now(), created: Date.now() };
  }
  if (!PLAN_TOKENS[acct.plan]) acct.plan = 'free';
  if (typeof acct.tokens !== 'number') acct.tokens = PLAN_TOKENS[acct.plan];
  if (typeof acct.cycleStart !== 'number') acct.cycleStart = Date.now();
  return acct;
}

/* Lazy monthly refill for paid plans. Mutates and returns acct. */
function applyReset(acct, now) {
  if (acct.plan === 'monthly' || acct.plan === 'lifetime') {
    let advanced = false;
    while (now - acct.cycleStart >= CYCLE_MS) {
      acct.cycleStart += CYCLE_MS;
      advanced = true;
    }
    if (advanced) acct.tokens = PLAN_TOKENS[acct.plan];
  }
  return acct;
}

async function saveAccount(redis, email, acct) {
  try { await redis.set(`roast:acct:${email}`, JSON.stringify(acct)); } catch (e) {}
}

/* Report the current balance without consuming (for /api/auth?action=me). */
export async function peekAccount(redis, rawEmail) {
  const email = normEmail(rawEmail);
  if (!email) return null;
  if (UNLIMITED_EMAILS.has(email)) return { plan: 'unlimited', tokens: UNLIMITED_BALANCE };
  const acct = applyReset(await readAccount(redis, email), Date.now());
  await saveAccount(redis, email, acct);
  return { plan: acct.plan, tokens: acct.tokens };
}

/* Consume one token for a roast. Returns { authed, full, remaining, plan }.
   full=false means the account is out of tokens (roast should be gated). */
export async function consumeToken(redis, rawEmail) {
  const email = normEmail(rawEmail);
  if (!email) return { authed: false, full: false, remaining: 0, plan: null };
  if (UNLIMITED_EMAILS.has(email)) return { authed: true, full: true, remaining: UNLIMITED_BALANCE, plan: 'unlimited' };
  const acct = applyReset(await readAccount(redis, email), Date.now());
  if (acct.tokens > 0) {
    acct.tokens -= 1;
    await saveAccount(redis, email, acct);
    return { authed: true, full: true, remaining: acct.tokens, plan: acct.plan };
  }
  await saveAccount(redis, email, acct);
  return { authed: true, full: false, remaining: 0, plan: acct.plan };
}

/* Grant a paid plan after a successful Stripe checkout (idempotent-ish). */
export async function grantPlan(redis, rawEmail, plan) {
  const email = normEmail(rawEmail);
  if (!email || !PLAN_TOKENS[plan] || plan === 'free') return false;
  await saveAccount(redis, email, { plan, tokens: PLAN_TOKENS[plan], cycleStart: Date.now(), created: Date.now() });
  return true;
}

/* Downgrade to free when a subscription is cancelled or a payment fails. Keeps
   whatever tokens remain (they were paid for) but stops future monthly refills. */
export async function downgradeToFree(redis, rawEmail) {
  const email = normEmail(rawEmail);
  if (!email) return false;
  const acct = await readAccount(redis, email);
  acct.plan = 'free';
  await saveAccount(redis, email, acct);
  return true;
}
