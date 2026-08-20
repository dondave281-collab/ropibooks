const db = require('../_lib/supabase');
const { ok, requireMethod, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const msgs = await db.select('messages', 'select=*&order=created_at.desc');
  ok(res, { messages: msgs });
});
