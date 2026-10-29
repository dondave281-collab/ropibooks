const bcrypt = require('bcryptjs');
const db = require('../_lib/supabase');
const { notifyAdmin } = require('../_lib/mailer');
const { ok, fail, generateToken, hashToken, clientIp, validEmail, requireUser, tooManyAttempts, recordAttempt, withHandler } = require('../_lib/util');

// Public — safe to be in source, this is not a secret.
const GOOGLE_CLIENT_ID = '796935578270-7g5p1s4l7lj8gqfpkismslr2rjh2kcub.apps.googleusercontent.com';

async function makeSession(user, res){
  const token = generateToken();
  const days = Number(process.env.SESSION_TTL_DAYS || 7);
  await db.insert('sessions', {
    user_id: user.id, token_hash: hashToken(token), ip: null,
    expires_at: new Date(Date.now() + days * 86400000).toISOString(),
  });
  return { token, user: { id: user.id, name: user.name, email: user.email } };
}

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
    const user = await db.insert('users', { name: cleanName, email: cleanEmail, password_hash: passwordHash, provider: 'email' });
    const session = await makeSession(user, res);

    notifyAdmin(
      'New signup — Restorers of Paths',
      `A new user just signed up.\n\nName: ${cleanName}\nEmail: ${cleanEmail}\nMethod: Email/Password\nTime: ${new Date().toISOString()}`
    );

    return ok(res, session);
  }

  if (action === 'login' && req.method === 'POST') {
    const { email = '', password = '' } = req.body || {};
    const cleanEmail = String(email).toLowerCase().trim();
    if (!validEmail(cleanEmail) || !password) return fail(res, 422, 'Invalid email or password.');
    if (await tooManyAttempts(cleanEmail)) return fail(res, 429, 'Too many failed attempts. Please try again in 15 minutes.');

    const rows = await db.select('users', `email=eq.${encodeURIComponent(cleanEmail)}&select=*`);
    const user = rows[0];

    if (user && !user.password_hash) {
      return fail(res, 401, 'This account uses Google Sign-In — please continue with Google.');
    }

    const valid = user && await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await recordAttempt(cleanEmail, clientIp(req), false);
      return fail(res, 401, 'Invalid email or password.');
    }
    await recordAttempt(cleanEmail, clientIp(req), true);
    const session = await makeSession(user, res);
    return ok(res, session);
  }

  // Real Google Sign-In: verify the ID token Google issued, server-side, before trusting it.
  if (action === 'google' && req.method === 'POST') {
    const { credential = '' } = req.body || {};
    if (!credential) return fail(res, 422, 'Missing Google credential.');

    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!verifyRes.ok) return fail(res, 401, 'Could not verify Google credential.');
    const claims = await verifyRes.json();

    if (claims.aud !== GOOGLE_CLIENT_ID) return fail(res, 401, 'Invalid Google credential.');
    if (claims.email_verified !== 'true' && claims.email_verified !== true) {
      return fail(res, 401, 'Google account email is not verified.');
    }

    const cleanEmail = String(claims.email || '').toLowerCase().trim();
    const name = String(claims.name || cleanEmail.split('@')[0]);
    const googleId = String(claims.sub || '');
    if (!validEmail(cleanEmail)) return fail(res, 401, 'Invalid Google account email.');

    let rows = await db.select('users', `email=eq.${encodeURIComponent(cleanEmail)}&select=*`);
    let user = rows[0];
    let isNewUser = false;

    if (!user) {
      user = await db.insert('users', { name, email: cleanEmail, password_hash: null, provider: 'google', google_id: googleId });
      isNewUser = true;
    } else if (!user.google_id) {
      const updated = await db.update('users', `id=eq.${user.id}`, { google_id: googleId });
      user = updated[0] || user;
    }

    if (isNewUser) {
      notifyAdmin(
        'New signup — Restorers of Paths',
        `A new user just signed up.\n\nName: ${name}\nEmail: ${cleanEmail}\nMethod: Google Sign-In\nTime: ${new Date().toISOString()}`
      );
    }

    const session = await makeSession(user, res);
    return ok(res, session);
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
