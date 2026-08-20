const db = require('../_lib/supabase');
const { ok, fail, validEmail, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'subscribe' && req.method === 'POST') {
    const email = String((req.body || {}).email || '').toLowerCase().trim();
    if (!validEmail(email)) return fail(res, 422, 'Valid email required.');
    const existing = await db.select('subscribers', `email=eq.${encodeURIComponent(email)}&select=id`);
    if (!existing.length) await db.insert('subscribers', { email });
    return ok(res, { ok: true });
  }

  if (action === 'list' && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const subs = await db.select('subscribers', 'select=email&order=subscribed_at.desc');
    return ok(res, { subscribers: subs.map((s) => s.email) });
  }

  fail(res, 404, 'Not found');
});
