const db = require('../_lib/supabase');
const { ok, requireMethod, requireUser, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;
  const user = await requireUser(req, res);
  if (!user) return;
  const rows = await db.select('library', `user_id=eq.${user.id}&select=book_id,purchased_at,books(id,title,cover_url)`);
  ok(res, { library: rows });
});
