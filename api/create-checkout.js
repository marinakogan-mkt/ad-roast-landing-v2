import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

/* Plan catalog (monetization #3). Uses stable Stripe Price IDs (created once in
   the live account) so the dashboard stays clean and reporting groups correctly.
   `grant` is the entitlement plan actually stored on the account (so starter_monthly
   and starter_yearly both grant "starter"); when absent the key IS the grant.
     starter -> 1 company, 25 roasts/cycle  ($29/mo or $290/yr)
     pro     -> up to 5 companies, 100 roasts/cycle ($79/mo or $790/yr)
     lifetime-> $482 one-time, 20 roasts/cycle for life (kept as-is)
     monthly -> legacy $24/mo (kept so existing subscribers keep renewing)
   TODO(Marina): replace the four price_REPLACE_* IDs with the real Stripe Price IDs
   (Dashboard -> Products -> AdRoast Starter / AdRoast Pro, monthly + yearly). Until
   then the Starter/Pro buttons will 400 at Stripe; Lifetime and legacy monthly work. */
const PLANS = {
  starter_monthly: { mode: 'subscription', price: 'price_REPLACE_starter_monthly', grant: 'starter' },
  starter_yearly:  { mode: 'subscription', price: 'price_REPLACE_starter_yearly',  grant: 'starter' },
  pro_monthly:     { mode: 'subscription', price: 'price_REPLACE_pro_monthly',     grant: 'pro' },
  pro_yearly:      { mode: 'subscription', price: 'price_REPLACE_pro_yearly',       grant: 'pro' },
  lifetime: { mode: 'payment',      price: 'price_1TyoueCiAk9fSDtoRbM2FRfs' },
  monthly:  { mode: 'subscription', price: 'price_1TyoueCiAk9fSDtodYc7pflP' }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { email } = body;
  const plan = PLANS[body.plan] ? body.plan : 'starter_monthly';
  if (!email) return res.status(400).json({ error: 'Email required' });

  const siteUrl = process.env.SITE_URL || 'https://adroast.in';
  const p = PLANS[plan];
  // Entitlement plan stored on the account (starter/pro/lifetime/monthly) — strips the billing cycle.
  const grantKey = p.grant || plan;

  const params = {
    'mode': p.mode,
    'line_items[0][price]': p.price,
    'line_items[0][quantity]': '1',
    'customer_email': email,
    'success_url': `${siteUrl}?payment=success&plan=${grantKey}&session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url': `${siteUrl}?payment=cancelled`,
    'metadata[email]': email,
    'metadata[plan]': grantKey,
    'metadata[priced_plan]': plan
  };

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params).toString()
    });

    const session = await response.json();
    if (session.error) return res.status(400).json({ error: session.error.message });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to create checkout' });
  }
}
