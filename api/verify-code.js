import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { email, code } = body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

  const normalizedEmail = email.trim().toLowerCase();

  // Check code
  const storedCode = await kv.get(`code:${normalizedEmail}`);
  if (!storedCode || storedCode !== code) {
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  // Delete used code
  await kv.del(`code:${normalizedEmail}`);

  // Check audit count for this email
  const auditCount = (await kv.get(`audits:count:${normalizedEmail}`)) || 0;

  // Generate a session token (simple random string)
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  await kv.set(`session:${token}`, normalizedEmail, { ex: 86400 }); // 24h TTL

  return res.status(200).json({
    ok: true,
    email: normalizedEmail,
    auditCount: Number(auditCount),
    hasFreeAudit: Number(auditCount) === 0,
    token
  });
}
