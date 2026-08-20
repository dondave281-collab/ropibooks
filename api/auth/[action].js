const bcrypt = require('bcryptjs');
const db = require('../_lib/supabase');
const { ok, fail, generateToken, hashToken, clientIp, validEmail, requireUser, tooManyAttempts, recordAttempt, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'signup' && req.method === 'POST') {
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
      user_id: user.id, token_hash: hashToken(token), ip: clientIp(req),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 255),
      expires_at: new Date(Date.now() + days * 86400000).toISOString(),
    });
    return ok(res, { token, user: { id: user.id, name: user.name, email: user.email } });
  }

  if (action === 'login' && req.method === 'POST') {
    const { email = '', password = '' } = req.body || {};
    const cleanEmail = String(email).toLowerCase().trim();
    if (!validEmail(cleanEmail) || !password) return fail(res, 422, 'Invalid email or password.');
    if (await tooManyAttempts(cleanEmail)) return fail(res, 429, 'Too many failed attempts. Please try again in 15 minutes.');

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
      user_id: user.id, token_hash: hashToken(token), ip: clientIp(req),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 255),
      expires_at: new Date(Date.now() + days * 86400000).toISOString(),
    });
    return ok(res, { token, user: { id: user.id, name: user.name, email: user.email } });
  }

  if (action === 'logout' && req.method === 'POST') {
    const auth = req.headers['authorization'] || '';
    const m = auth.match(/Bearer\s+(\S+)/i);
    if (m) await db.delete('sessions', `token_hash=eq.${hashToken(m[1])}`);
    return ok(res, { ok: true });
  }

  if (action === 'session' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    return ok(res, { user: { id: user.id, name: user.name, email: user.email } });
  }

  fail(res, 404, 'Not found');
});
