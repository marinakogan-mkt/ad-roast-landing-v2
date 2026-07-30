import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

/* Plan catalog (monetization #3). Prices are built inline via Stripe price_data,
   so no products need to be pre-created in the Stripe dashboard.
     monthly  -> $24/mo recurring subscription, 20 roasts per cycle
     lifetime -> $482 one-time, 20 roasts per cycle for life */
const PLANS = {
  monthly:  { mode: 'subscription', amount: 2400, name: 'AdRoast Monthly',  desc: '20 ad roasts per month', recurring: true },
  lifetime: { mode: 'payment',      amount: 48200, name: 'AdRoast Lifetime', desc: '20 ad roasts per month, for life', recurring: false }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  /* TEMP one-time setup: create stable Stripe Products/Prices and return their IDs.
     Removed immediately after the IDs are hardcoded below. */
  if (body.setup === 'make_prices' && body.secret === 'qz7Kp2Rm9xVt') {
    const mk = async (params) => {
      const r = await fetch('https://api.stripe.com/v1/prices', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString()
      });
      return r.json();
    };
    const monthly = await mk({ 'currency': 'usd', 'unit_amount': '2400', 'recurring[interval]': 'month', 'product_data[name]': 'AdRoast Monthly' });
    const lifetime = await mk({ 'currency': 'usd', 'unit_amount': '48200', 'product_data[name]': 'AdRoast Lifetime' });
    return res.status(200).json({ monthly: monthly.id || null, monthlyErr: monthly.error || null, lifetime: lifetime.id || null, lifetimeErr: lifetime.error || null });
  }

  const { email } = body;
  const plan = PLANS[body.plan] ? body.plan : 'monthly';
  if (!email) return res.status(400).json({ error: 'Email required' });

  const siteUrl = process.env.SITE_URL || 'https://adroast.in';
  const p = PLANS[plan];

  const params = {
    'mode': p.mode,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(p.amount),
    'line_items[0][price_data][product_data][name]': p.name,
    'line_items[0][price_data][product_data][description]': p.desc,
    'line_items[0][quantity]': '1',
    'customer_email': email,
    'success_url': `${siteUrl}?payment=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url': `${siteUrl}?payment=cancelled`,
    'metadata[email]': email,
    'metadata[plan]': plan
  };
  /* Subscriptions need a recurring interval on the inline price. */
  if (p.recurring) params['line_items[0][price_data][recurring][interval]'] = 'month';

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
