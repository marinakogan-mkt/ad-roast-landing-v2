import { Redis } from '@upstash/redis';
import { grantPlan, downgradeToFree, forceRenew, settleAllAccounts } from './_tokens.js';
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

  /* ---- Daily cron: settle recurring credits ---------------------------------
     Vercel Cron hits this once a day. It refills any paid account whose 30-day
     cycle rolled over and emails them once, so lifetime accounts (which get no
     Stripe renewal event) still receive their monthly roasts on time. Protected
     by CRON_SECRET: Vercel sends it as a Bearer token when the env var is set. */
  if (req.query && req.query.cron === 'refills') {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers['authorization'] || '';
    if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const summary = await settleAllAccounts(kv);
      return res.status(200).json({ ok: true, ...summary });
    } catch (e) {
      console.error('[cron refills] error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }

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
        if (evt && !evt.error) {
          const obj = (evt.data && evt.data.object) || {};
          const resolveEmail = async () => {
            let email = obj.customer_email || null;
            if (!email && obj.customer) {
              const cust = await stripeGet(`customers/${obj.customer}`);
              email = cust && cust.email;
            }
            return email;
          };
          /* Cancellation / failed payment: stop future refills. */
          if (evt.type === 'customer.subscription.deleted' || evt.type === 'invoice.payment_failed') {
            const email = await resolveEmail();
            if (email) { try { await downgradeToFree(kv, email); } catch (e) { console.error('[webhook] downgrade failed:', e.message); } }
          }
          /* Monthly renewal: Stripe charged the card for a new cycle. Refill the
             20 roasts now and email. Only on subscription_cycle (a renewal), not
             subscription_create (the first invoice, already handled at checkout). */
          if (evt.type === 'invoice.payment_succeeded' && obj.billing_reason === 'subscription_cycle') {
            const email = await resolveEmail();
            if (email) { try { await forceRenew(kv, email); } catch (e) { console.error('[webhook] renew failed:', e.message); } }
          }
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
        /* Idempotent per checkout session: refreshing /?payment=success must NOT
           re-grant 20 tokens. We only grant once per session id. */
        try {
          const already = await kv.get(`roast:granted:${sessionId}`);
          if (!already) {
            await grantPlan(kv, email, plan);
            await kv.set(`roast:granted:${sessionId}`, '1', { ex: 60 * 60 * 24 * 90 });
          }
        } catch (e) { console.error('[verify-payment] grantPlan failed:', e.message); }
      }
      return res.status(200).json({ ok: true, paid: true, email, plan: plan || null });
    }
    return res.status(200).json({ ok: true, paid: false });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
}
