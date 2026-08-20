const { ok, requireMethod, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  ok(res, { username: admin.username });
});
