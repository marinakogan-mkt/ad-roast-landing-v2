import { Redis } from '@upstash/redis';
import { grantPlan } from './_tokens.js';
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
      const email = (session.metadata && session.metadata.email) || session.customer_email;
      const plan = session.metadata && session.metadata.plan;
      /* Grant the purchased plan + its token allowance. Falls back gracefully if
         metadata is missing (older $35 one-off links). */
      if (email && (plan === 'monthly' || plan === 'lifetime')) {
        try { await grantPlan(kv, email, plan); } catch (e) { console.error('[verify-payment] grantPlan failed:', e.message); }
      }
      return res.status(200).json({ ok: true, paid: true, email, plan: plan || null });
    }
    return res.status(200).json({ ok: true, paid: false });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
}
