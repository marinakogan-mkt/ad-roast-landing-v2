/**
 * Onboarding + lifecycle emails for roast accounts. Underscore-prefixed so
 * Vercel treats it as a shared module, not a serverless function (12-function
 * Hobby cap).
 *
 * Channels:
 *   - New-signup welcome + drip: routed to Loops when LOOPS_API_KEY is set
 *     (Loops runs the whole 3-email sequence). Falls back to a single EmailJS
 *     welcome (Day 0 only) when Loops is not configured.
 *   - Credits-renewed email: transactional, always via EmailJS.
 *
 * Every function is fail-open: an email/Loops failure must never block or slow
 * a sign-in, a roast, or a webhook.
 */
const EMAILJS_SERVICE_ID = 'service_ywioabe';
const EMAILJS_TEMPLATE_ID = 'template_gtqow85';
const EMAILJS_PUBLIC_KEY = '964Wa83HevoEa5KnS';

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

async function emailjsSend(toEmail, subject, message) {
  try {
    const payload = {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: { to_email: toEmail, subject, message }
    };
    if (process.env.EMAILJS_PRIVATE_KEY) payload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
    await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { /* non-fatal */ }
}

/* ---- Welcome + drip ------------------------------------------------------- */

const WELCOME_SUBJECT = 'Your AdRoast account is live';
const WELCOME_MESSAGE = `You are in.

AdRoast does one thing: it tells you, honestly, whether your ad and landing page convert the right buyer, and it hands you the exact fixes.

Paste an ad and its landing page. In about two minutes you get:

- An ad score, a landing-page score, and an ad-to-page match score
- The specific issues holding each one back, ranked by severity
- A Fix Kit: rewritten ad and landing-page messaging, ready to ship

Your first roast is free. No call, no card.

Run your first roast: https://www.adroast.in

Talk soon,
Marina`;

/* Add the contact to Loops and fire the "signed_up" event so the Loops loop
   sends the full welcome + drip sequence. No-op (returns false) if Loops is not
   configured, so the caller can fall back to the EmailJS welcome. */
async function loopsSignup(email) {
  const key = process.env.LOOPS_API_KEY;
  if (!key) return false;
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  try {
    await fetch('https://app.loops.so/api/v1/contacts/update', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ email, source: 'adroast', userGroup: 'roast-users', subscribed: true })
    });
    await fetch('https://app.loops.so/api/v1/events/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, eventName: 'signed_up' })
    });
    return true;
  } catch (e) { return false; }
}

/* Fire onboarding once per brand-new roast account, ever. Idempotent via an NX
   Redis flag (so email prefetch + real click can't double-fire), and existing
   accounts are skipped so long-time users are never "welcomed". Routes to Loops
   when configured, else sends the single EmailJS welcome. */
export async function onNewSignup(redis, rawEmail) {
  const email = normEmail(rawEmail);
  if (!email) return;
  try {
    const claimed = await redis.set(`roast:welcomed:${email}`, '1', { nx: true, ex: 60 * 60 * 24 * 365 });
    if (!claimed) return;               // already onboarded (or claim in flight)
    const acct = await redis.get(`roast:acct:${email}`);
    if (acct) return;                   // returning customer: never welcome
  } catch (e) {
    return;                             // Redis down: skip rather than risk a dupe
  }
  const routedToLoops = await loopsSignup(email);
  if (!routedToLoops) await emailjsSend(email, WELCOME_SUBJECT, WELCOME_MESSAGE);
}

/* ---- Credits renewed (monthly cycle / lifetime monthly grant) ------------- */

const RENEWED_SUBJECT = 'Your AdRoast roasts just renewed';
function renewedMessage(plan, tokens) {
  const lead = plan === 'lifetime' ? "This month's roast credits just landed in your account."
                                   : 'Your monthly roast credits just renewed.';
  return `${lead}

You now have ${tokens} roasts ready to use.

Run one at https://www.adroast.in — paste an ad and its landing page and get your score plus the exact fixes in about two minutes.

Talk soon,
Marina`;
}

/* Transactional "your credits renewed" email. Idempotency is enforced by the
   caller (once per billing cycle), so this just sends. */
export async function sendCreditsRenewedEmail(redis, rawEmail, plan, tokens) {
  const email = normEmail(rawEmail);
  if (!email) return;
  await emailjsSend(email, RENEWED_SUBJECT, renewedMessage(plan, tokens));
}
