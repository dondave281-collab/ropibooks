const db = require('../_lib/supabase');
const { ok, fail, requireMethod, requireUser, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;
  const user = await requireUser(req, res);
  if (!user) return;

  const ref = String(req.query.reference || '');
  if (!ref) return fail(res, 422, 'reference is required.');

  const rows = await db.select('orders', `order_ref=eq.${encodeURIComponent(ref)}&user_id=eq.${user.id}&select=id,order_ref,status,total,items,created_at`);
  if (!rows.length) return fail(res, 404, 'Order not found.');
  ok(res, { order: rows[0] });
});
