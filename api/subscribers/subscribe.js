const db = require('../_lib/supabase');
const { ok, fail, requireMethod, validEmail, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
  const email = String((req.body || {}).email || '').toLowerCase().trim();
  if (!validEmail(email)) return fail(res, 422, 'Valid email required.');

  const existing = await db.select('subscribers', `email=eq.${encodeURIComponent(email)}&select=id`);
  if (!existing.length) await db.insert('subscribers', { email });
  ok(res, { ok: true });
});
