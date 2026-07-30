import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

/* Plan catalog (monetization #3). Uses stable Stripe Price IDs (created once in
   the live account) so the dashboard stays clean and reporting groups correctly.
     monthly  -> $24/mo recurring subscription, 20 roasts per cycle
     lifetime -> $482 one-time, 20 roasts per cycle for life */
const PLANS = {
  monthly:  { mode: 'subscription', price: 'price_1TyoueCiAk9fSDtodYc7pflP' },
  lifetime: { mode: 'payment',      price: 'price_1TyoueCiAk9fSDtoRbM2FRfs' }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { email } = body;
  const plan = PLANS[body.plan] ? body.plan : 'monthly';
  if (!email) return res.status(400).json({ error: 'Email required' });

  const siteUrl = process.env.SITE_URL || 'https://adroast.in';
  const p = PLANS[plan];

  const params = {
    'mode': p.mode,
    'line_items[0][price]': p.price,
    'line_items[0][quantity]': '1',
    'customer_email': email,
    'success_url': `${siteUrl}?payment=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url': `${siteUrl}?payment=cancelled`,
    'metadata[email]': email,
    'metadata[plan]': plan
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
