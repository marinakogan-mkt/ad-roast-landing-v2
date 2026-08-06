/**
 * Welcome email for brand-new roast accounts (Email 1 of the onboarding
 * sequence). Underscore-prefixed so Vercel treats it as a shared module, not a
 * serverless function (the project is at the 12-function Hobby cap).
 *
 * Fires at most once per email, ever, and only for genuinely new users (no
 * roast account yet). Never throws: a welcome-email failure must not block or
 * slow a sign-in. The Day-2 / Day-4 drip in the campaign doc needs a scheduler
 * or ESP and is intentionally NOT sent from here.
 */
const EMAILJS_SERVICE_ID = 'service_ywioabe';
const EMAILJS_TEMPLATE_ID = 'template_gtqow85';
const EMAILJS_PUBLIC_KEY = '964Wa83HevoEa5KnS';

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

/* Send the welcome email once per new user. Idempotent via an NX Redis flag so
   concurrent sign-ins (email prefetch + real click) can't double-send, and
   existing accounts are skipped so long-time users are never "welcomed". */
export async function sendWelcomeEmail(redis, rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return;

  try {
    /* First caller to set the flag owns the send. TTL 1y is plenty. */
    const claimed = await redis.set(`roast:welcomed:${email}`, '1', { nx: true, ex: 60 * 60 * 24 * 365 });
    if (!claimed) return; // already welcomed (or claim in flight)

    /* Only email genuinely new users. If a roast account already exists, this is
       a returning customer: keep the flag set (so we never retry) but send nothing. */
    const acct = await redis.get(`roast:acct:${email}`);
    if (acct) return;
  } catch (e) {
    return; // Redis unavailable: skip rather than risk a duplicate send
  }

  try {
    const payload = {
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: { to_email: email, subject: WELCOME_SUBJECT, message: WELCOME_MESSAGE }
    };
    if (process.env.EMAILJS_PRIVATE_KEY) payload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
    await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { /* non-fatal */ }
}
