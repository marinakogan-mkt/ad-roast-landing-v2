import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { token, linkedin } = body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  // Verify session
  const email = await kv.get(`session:${token}`);
  if (!email) return res.status(401).json({ error: 'Invalid or expired session' });

  // Increment audit count
  const currentCount = (await kv.get(`audits:count:${email}`)) || 0;
  await kv.set(`audits:count:${email}`, Number(currentCount) + 1);

  // Save LinkedIn if provided
  if (linkedin) {
    await kv.set(`linkedin:${email}`, linkedin);
  }

  return res.status(200).json({ ok: true });
}
