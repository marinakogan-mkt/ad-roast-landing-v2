import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { email, linkedin } = body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const normalizedEmail = email.trim().toLowerCase();

  // Check if this email has already used the free audit
  const used = await kv.get(`used:${normalizedEmail}`);

  // Save LinkedIn if provided
  if (linkedin) {
    await kv.set(`linkedin:${normalizedEmail}`, linkedin);
  }

  if (used) {
    return res.status(200).json({ ok: true, free: false });
  }

  // Mark as used
  await kv.set(`used:${normalizedEmail}`, new Date().toISOString());

  return res.status(200).json({ ok: true, free: true });
}
