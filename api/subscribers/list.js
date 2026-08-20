const db = require('../_lib/supabase');
const { ok, requireMethod, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const subs = await db.select('subscribers', 'select=email&order=subscribed_at.desc');
  ok(res, { subscribers: subs.map((s) => s.email) });
});
