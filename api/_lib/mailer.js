/**
 * Sends a plain-text notification email to the admin via Resend's API.
 * Failures here are swallowed (logged, not thrown) so a flaky email
 * provider never breaks signup or checkout for the user.
 */
async function notifyAdmin(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!apiKey || !to) {
    console.log('notifyAdmin skipped: RESEND_API_KEY or ADMIN_NOTIFY_EMAIL not set');
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Restorers of Paths <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('notifyAdmin failed:', res.status, body);
    }
  } catch (err) {
    console.error('notifyAdmin error:', err.message);
  }
}

module.exports = { notifyAdmin };
