const bcrypt = require('bcryptjs');
const db = require('../_lib/supabase');
const { ok, fail, requireMethod, generateToken, hashToken, clientIp, validEmail, tooManyAttempts, recordAttempt, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
  const { email = '', password = '' } = req.body || {};
  const cleanEmail = String(email).toLowerCase().trim();

  if (!validEmail(cleanEmail) || !password) return fail(res, 422, 'Invalid email or password.');

  if (await tooManyAttempts(cleanEmail)) {
    return fail(res, 429, 'Too many failed attempts. Please try again in 15 minutes.');
  }

  const rows = await db.select('users', `email=eq.${encodeURIComponent(cleanEmail)}&select=*`);
  const user = rows[0];
  const valid = user && await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    await recordAttempt(cleanEmail, clientIp(req), false);
    return fail(res, 401, 'Invalid email or password.');
  }

  await recordAttempt(cleanEmail, clientIp(req), true);

  const token = generateToken();
  const days = Number(process.env.SESSION_TTL_DAYS || 7);
  await db.insert('sessions', {
    user_id: user.id,
    token_hash: hashToken(token),
    ip: clientIp(req),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 255),
    expires_at: new Date(Date.now() + days * 86400000).toISOString(),
  });

  ok(res, { token, user: { id: user.id, name: user.name, email: user.email } });
});
