import { Redis } from '@upstash/redis';
import { grantPlan, downgradeToFree } from './_tokens.js';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

const STRIPE = process.env.STRIPE_SECRET_KEY;
async function stripeGet(path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { 'Authorization': `Bearer ${STRIPE}` } });
  return r.json();
}

export default async function handler(req, res) {
  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }
  if (!body || typeof body !== 'object') body = {};

  /* ---- Stripe webhook: subscription lifecycle (monetization #3) --------------
     Stripe POSTs subscription events here. We don't trust the payload blindly —
     we re-fetch the event from Stripe by id to confirm it's genuine, then act on
     the authoritative copy (this avoids needing the raw-body signing secret).
     Always returns 200 so Stripe doesn't retry-storm. */
  if (req.query && req.query.hook === 'stripe') {
    if (req.method !== 'POST') return res.status(405).end();
    try {
      const evtId = body.id;
      if (evtId) {
        const evt = await stripeGet(`events/${encodeURIComponent(evtId)}`);
        if (evt && !evt.error && (evt.type === 'customer.subscription.deleted' || evt.type === 'invoice.payment_failed')) {
          const obj = (evt.data && evt.data.object) || {};
          let email = obj.customer_email || null;
          if (!email && obj.customer) {
            const cust = await stripeGet(`customers/${obj.customer}`);
            email = cust && cust.email;
          }
          if (email) { try { await downgradeToFree(kv, email); } catch (e) { console.error('[webhook] downgrade failed:', e.message); } }
        }
      }
    } catch (e) { console.error('[webhook] error:', e.message); }
    return res.status(200).json({ received: true });
  }

  /* ---- Normal path: verify a checkout session + grant the plan ---------------- */
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId } = body;
  if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

  try {
    const session = await stripeGet(`checkout/sessions/${sessionId}`);
    if (session.error) return res.status(400).json({ error: session.error.message });

    if (session.payment_status === 'paid') {
      const email = (session.metadata && session.metadata.email) || session.customer_email;
      const plan = session.metadata && session.metadata.plan;
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
