const db = require('../_lib/supabase');
const { ok, fail, validEmail, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'send' && req.method === 'POST') {
    const { name = '', email = '', message = '' } = req.body || {};
    const cleanName = String(name).trim();
    const cleanEmail = String(email).toLowerCase().trim();
    const cleanMessage = String(message).trim();
    if (!cleanName || !validEmail(cleanEmail) || !cleanMessage) return fail(res, 422, 'Name, valid email, and message are required.');
    if (cleanMessage.length > 5000) return fail(res, 422, 'Message too long.');
    await db.insert('messages', { name: cleanName, email: cleanEmail, message: cleanMessage });
    return ok(res, { ok: true });
  }

  if (action === 'list' && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const msgs = await db.select('messages', 'select=*&order=created_at.desc');
    return ok(res, { messages: msgs });
  }

  fail(res, 404, 'Not found');
});
