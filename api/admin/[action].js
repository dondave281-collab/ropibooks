const bcrypt = require('bcryptjs');
const db = require('../_lib/supabase');
const { ok, fail, generateToken, hashToken, clientIp, requireAdmin, tooManyAttempts, recordAttempt, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'login' && req.method === 'POST') {
    const { username = '', password = '' } = req.body || {};
    const cleanUsername = String(username).trim();
    const identifier = 'admin:' + cleanUsername.toLowerCase();
    if (!cleanUsername || !password) return fail(res, 422, 'Username and password required.');
    if (await tooManyAttempts(identifier, 5, 15)) return fail(res, 429, 'Too many failed attempts. Please try again in 15 minutes.');

    const rows = await db.select('admin_users', `username=eq.${encodeURIComponent(cleanUsername)}&select=*`);
    const admin = rows[0];
    const valid = admin && await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      await recordAttempt(identifier, clientIp(req), false);
      return fail(res, 401, 'Invalid credentials.');
    }
    await recordAttempt(identifier, clientIp(req), true);

    const token = generateToken();
    const hours = Number(process.env.ADMIN_SESSION_TTL_HOURS || 12);
    await db.insert('admin_sessions', {
      admin_id: admin.id, token_hash: hashToken(token), ip: clientIp(req),
      expires_at: new Date(Date.now() + hours * 3600000).toISOString(),
    });
    return ok(res, { token, username: admin.username });
  }

  if (action === 'session' && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    return ok(res, { username: admin.username });
  }

  if (action === 'users' && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const users = await db.select('users', 'select=id,name,email,created_at&order=created_at.desc');
    return ok(res, { users });
  }

  fail(res, 404, 'Not found');
});
