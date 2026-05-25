import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { sessionId } = body;
  if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

  try {
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
    });

    const session = await response.json();
    if (session.error) return res.status(400).json({ error: session.error.message });

    if (session.payment_status === 'paid') {
      return res.status(200).json({ ok: true, paid: true, email: session.customer_email });
    }
    return res.status(200).json({ ok: true, paid: false });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
}
