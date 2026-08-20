const db = require('../_lib/supabase');
const { ok, fail, requireMethod, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { orderId = '', status = '' } = req.body || {};
  const allowed = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
  if (!orderId || !allowed.includes(status)) return fail(res, 422, 'orderId and a valid status are required.');

  const rows = await db.update('orders', `id=eq.${encodeURIComponent(orderId)}`, { status, updated_at: new Date().toISOString() });
  ok(res, { order: rows[0] || null });
});
