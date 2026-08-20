const db = require('../_lib/supabase');
const { ok, requireMethod, bearerToken, hashToken, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
  const token = bearerToken(req);
  if (token) await db.delete('sessions', `token_hash=eq.${hashToken(token)}`);
  ok(res, { ok: true });
});
