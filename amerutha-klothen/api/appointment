export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, phone, email = '', outfit, date, time, notes = '' } = req.body || {};
  if (![name, phone, outfit, date, time].every(v => typeof v === 'string' && v.trim())) {
    return res.status(400).json({ error: 'Please complete all required appointment fields.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    return res.status(500).json({ error: 'Appointment email service is not configured yet.' });
  }

  const safe = value => String(value || '').replace(/[<>]/g, '').trim();
  const lines = [
    'A new appointment request was submitted on the Amerutha Klothen website.',
    '',
    `Name: ${safe(name)}`,
    `Phone: ${safe(phone)}`,
    `Customer email: ${safe(email) || 'Not provided'}`,
    `Outfit: ${safe(outfit)}`,
    `Preferred date: ${safe(date)}`,
    `Preferred time: ${safe(time)}`,
    `Additional notes: ${safe(notes) || 'None'}`
  ];

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL,
        to: ['ameruta69@gmail.com'],
        subject: `New appointment request — ${safe(name)}`,
        text: lines.join('\n'),
        ...(email ? { reply_to: email } : {})
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Resend error:', result);
      return res.status(502).json({ error: 'The email service could not send your request. Please try again later.' });
    }
    return res.status(200).json({ ok: true, id: result.id });
  } catch (error) {
    console.error('Appointment email error:', error);
    return res.status(500).json({ error: 'Unable to send appointment request right now.' });
  }
}
