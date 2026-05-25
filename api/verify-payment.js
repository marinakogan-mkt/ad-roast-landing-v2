import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { sessionId, token } = body;
  if (!sessionId || !token) return res.status(400).json({ error: 'Session ID and token required' });

  // Verify user session
  const email = await kv.get(`session:${token}`);
  if (!email) return res.status(401).json({ error: 'Invalid or expired session' });

  // Check if this payment was already verified (prevent double-use)
  const alreadyVerified = await kv.get(`payment:${sessionId}`);
  if (alreadyVerified) return res.status(200).json({ ok: true, paid: true });

  try {
    // Verify with Stripe
    const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`
      }
    });

    const session = await response.json();
    if (session.error) return res.status(400).json({ error: session.error.message });

    if (session.payment_status === 'paid') {
      // Mark this session as verified
      await kv.set(`payment:${sessionId}`, email, { ex: 86400 * 30 }); // 30 day TTL

      return res.status(200).json({ ok: true, paid: true });
    } else {
      return res.status(200).json({ ok: true, paid: false, status: session.payment_status });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
}
