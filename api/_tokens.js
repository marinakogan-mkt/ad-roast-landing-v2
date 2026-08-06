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

import { sendCreditsRenewedEmail } from './_welcome.js';

export const PLAN_TOKENS = { free: 1, monthly: 20, lifetime: 20 };
const CYCLE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/* Set of every paid account email, so the daily cron can poke each one to
   trigger a refill + "credits renewed" email even for users who never visit
   (lifetime accounts get no Stripe renewal event). */
const ACCOUNTS_SET = 'roast:accounts';

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

/* Lazy monthly refill for paid plans. Mutates acct in place; returns TRUE when a
   new cycle rolled over (tokens were refilled) so the caller can email once. */
function applyReset(acct, now) {
  let refilled = false;
  if (acct.plan === 'monthly' || acct.plan === 'lifetime') {
    while (now - acct.cycleStart >= CYCLE_MS) {
      acct.cycleStart += CYCLE_MS;
      refilled = true;
    }
    if (refilled) acct.tokens = PLAN_TOKENS[acct.plan];
  }
  return refilled;
}

async function saveAccount(redis, email, acct) {
  try { await redis.set(`roast:acct:${email}`, JSON.stringify(acct)); } catch (e) {}
}

function isPaid(acct) { return acct && (acct.plan === 'monthly' || acct.plan === 'lifetime'); }

/* Best-effort: keep a set of paid emails for the cron. Backfills existing paying
   customers the first time they read/roast after this ships. */
async function trackPaid(redis, email, acct) {
  if (isPaid(acct)) { try { await redis.sadd(ACCOUNTS_SET, email); } catch (e) {} }
}

/* Send the "credits renewed" email at most once per billing cycle. Keyed by
   cycleStart, so each new cycle emails exactly once no matter how many callers
   (lazy read, cron, webhook) notice the refill. Fail-open. */
async function emailRenewalOnce(redis, email, acct) {
  try {
    const claimed = await redis.set(`roast:renew_mail:${email}:${acct.cycleStart}`, '1', { nx: true, ex: 60 * 60 * 24 * 40 });
    if (!claimed) return;
  } catch (e) { return; }
  try { await sendCreditsRenewedEmail(redis, email, acct.plan, acct.tokens); } catch (e) {}
}

/* Report the current balance without consuming (for /api/auth?action=me). */
export async function peekAccount(redis, rawEmail) {
  const email = normEmail(rawEmail);
  if (!email) return null;
  if (UNLIMITED_EMAILS.has(email)) return { plan: 'unlimited', tokens: UNLIMITED_BALANCE };
  const acct = await readAccount(redis, email);
  const refilled = applyReset(acct, Date.now());
  await saveAccount(redis, email, acct);
  await trackPaid(redis, email, acct);
  if (refilled) await emailRenewalOnce(redis, email, acct);
  return { plan: acct.plan, tokens: acct.tokens };
}

/* Consume one token for a roast. Returns { authed, full, remaining, plan }.
   full=false means the account is out of tokens (roast should be gated). */
export async function consumeToken(redis, rawEmail) {
  const email = normEmail(rawEmail);
  if (!email) return { authed: false, full: false, remaining: 0, plan: null };
  if (UNLIMITED_EMAILS.has(email)) return { authed: true, full: true, remaining: UNLIMITED_BALANCE, plan: 'unlimited' };
  const acct = await readAccount(redis, email);
  const refilled = applyReset(acct, Date.now());
  await trackPaid(redis, email, acct);
  if (refilled) await emailRenewalOnce(redis, email, acct);
  if (acct.tokens > 0) {
    acct.tokens -= 1;
    await saveAccount(redis, email, acct);
    return { authed: true, full: true, remaining: acct.tokens, plan: acct.plan };
  }
  await saveAccount(redis, email, acct);
  return { authed: true, full: false, remaining: 0, plan: acct.plan };
}

/* Grant a paid plan after a successful Stripe checkout. cycleStart = now, so the
   billing month starts on the payment date. Idempotency is handled by the
   caller (once per checkout session id). */
export async function grantPlan(redis, rawEmail, plan) {
  const email = normEmail(rawEmail);
  if (!email || !PLAN_TOKENS[plan] || plan === 'free') return false;
  await saveAccount(redis, email, { plan, tokens: PLAN_TOKENS[plan], cycleStart: Date.now(), created: Date.now() });
  try { await redis.sadd(ACCOUNTS_SET, email); } catch (e) {}
  return true;
}

/* Force a fresh cycle right now: refill to the plan amount and reset cycleStart
   to now, then email once. Called by the Stripe invoice.payment_succeeded webhook
   on a monthly renewal (Stripe is the source of truth that a new cycle began).
   Returns { plan, tokens } or null when the account is not on a paid plan. */
export async function forceRenew(redis, rawEmail) {
  const email = normEmail(rawEmail);
  if (!email) return null;
  const acct = await readAccount(redis, email);
  if (!isPaid(acct)) return null;
  acct.tokens = PLAN_TOKENS[acct.plan];
  acct.cycleStart = Date.now();
  await saveAccount(redis, email, acct);
  try { await redis.sadd(ACCOUNTS_SET, email); } catch (e) {}
  await emailRenewalOnce(redis, email, acct);
  return { plan: acct.plan, tokens: acct.tokens };
}

/* Iterate every known paid account and settle it (lazy refill + one renewal
   email if a cycle rolled over). Used by the daily cron so lifetime accounts,
   which get no Stripe renewal event, still receive credits + an email on time.
   Returns a small summary for logging. */
export async function settleAllAccounts(redis) {
  let emails = [];
  try { emails = await redis.smembers(ACCOUNTS_SET); } catch (e) { return { checked: 0, renewed: 0 }; }
  let renewed = 0;
  for (const email of emails) {
    try {
      const acct = await readAccount(redis, email);
      if (!isPaid(acct)) continue;
      const refilled = applyReset(acct, Date.now());
      if (refilled) {
        await saveAccount(redis, email, acct);
        await emailRenewalOnce(redis, email, acct);
        renewed++;
      }
    } catch (e) { /* skip this account */ }
  }
  return { checked: emails.length, renewed };
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
