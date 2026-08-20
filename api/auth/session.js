const { ok, requireMethod, requireUser, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;
  const user = await requireUser(req, res);
  if (!user) return;
  ok(res, { user: { id: user.id, name: user.name, email: user.email } });
});
