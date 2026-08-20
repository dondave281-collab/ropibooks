const bcrypt = require('bcryptjs');
const db = require('../_lib/supabase');
const { ok, fail, requireMethod, generateToken, hashToken, clientIp, validEmail, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
  const { name = '', email = '', password = '' } = req.body || {};
  const cleanEmail = String(email).toLowerCase().trim();
  const cleanName = String(name).trim();

  if (!cleanName || !validEmail(cleanEmail) || String(password).length < 8) {
    return fail(res, 422, 'Please provide a valid name, email, and a password of at least 8 characters.');
  }

  const existing = await db.select('users', `email=eq.${encodeURIComponent(cleanEmail)}&select=id`);
  if (existing.length) return fail(res, 409, 'An account with this email already exists.');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.insert('users', { name: cleanName, email: cleanEmail, password_hash: passwordHash });

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
