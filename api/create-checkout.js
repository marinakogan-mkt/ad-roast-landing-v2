import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { email } = body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const siteUrl = process.env.SITE_URL || 'https://adroast.in';

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode': 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': '3500',
        'line_items[0][price_data][product_data][name]': 'AdRoast Full Audit',
        'line_items[0][price_data][product_data][description]': 'Permanent link to your complete ad positioning audit',
        'customer_email': email,
        'success_url': `${siteUrl}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `${siteUrl}?payment=cancelled`,
        'metadata[email]': email
      }).toString()
    });

    const session = await response.json();
    if (session.error) return res.status(400).json({ error: session.error.message });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to create checkout' });
  }
}
