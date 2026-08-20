const db = require('../_lib/supabase');
const { ok, fail, requireMethod, validEmail, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
  const { name = '', email = '', message = '' } = req.body || {};
  const cleanName = String(name).trim();
  const cleanEmail = String(email).toLowerCase().trim();
  const cleanMessage = String(message).trim();

  if (!cleanName || !validEmail(cleanEmail) || !cleanMessage) return fail(res, 422, 'Name, valid email, and message are required.');
  if (cleanMessage.length > 5000) return fail(res, 422, 'Message too long.');

  await db.insert('messages', { name: cleanName, email: cleanEmail, message: cleanMessage });
  ok(res, { ok: true });
});
