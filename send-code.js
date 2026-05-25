import { Redis } from '@upstash/redis';
const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') try { body = JSON.parse(body); } catch(e) { body = {}; }

  const { email } = body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const normalizedEmail = email.trim().toLowerCase();

  // Generate 6-digit code
  const code = String(Math.floor(100000 + Math.random() * 900000));

  // Store code in KV with 10-minute TTL
  await kv.set(`code:${normalizedEmail}`, code, { ex: 600 });

  // Send code via EmailJS
  try {
    await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: 'service_ywioabe',
        template_id: 'template_gtqow85',
        user_id: '964Wa83HevoEa5KnS',
        template_params: {
          to_email: normalizedEmail,
          subject: 'Your AdRoast verification code',
          message: `Your AdRoast verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`
        }
      })
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to send code' });
  }

  return res.status(200).json({ ok: true, message: 'Code sent' });
}
