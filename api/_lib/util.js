const crypto = require('crypto');
const db = require('./supabase');

function sendJson(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').send(JSON.stringify(data));
}

function ok(res, data) { sendJson(res, 200, data); }

function fail(res, status, message) { sendJson(res, status, { error: message }); }

function requireMethod(req, res, method) {
  if (req.method !== method) {
    fail(res, 405, 'Method not allowed');
    return false;
  }
  return true;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/Bearer\s+(\S+)/i);
  return m ? m[1] : null;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

async function requireUser(req, res) {
  const token = bearerToken(req);
  if (!token) { fail(res, 401, 'Not authenticated'); return null; }
  const rows = await db.select('sessions', `token_hash=eq.${hashToken(token)}&select=*,users(*)`);
  if (!rows.length) { fail(res, 401, 'Session invalid or expired'); return null; }
  const session = rows[0];
  if (new Date(session.expires_at).getTime() < Date.now()) { fail(res, 401, 'Session expired'); return null; }
  return session.users;
}

async function requireAdmin(req, res) {
  const token = bearerToken(req);
  if (!token) { fail(res, 401, 'Not authenticated'); return null; }
  const rows = await db.select('admin_sessions', `token_hash=eq.${hashToken(token)}&select=*,admin_users(*)`);
  if (!rows.length) { fail(res, 401, 'Admin session invalid or expired'); return null; }
  const session = rows[0];
  if (new Date(session.expires_at).getTime() < Date.now()) { fail(res, 401, 'Admin session expired'); return null; }
  return session.admin_users;
}

async function tooManyAttempts(identifier, limit = 6, windowMinutes = 15) {
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
  const rows = await db.select('login_attempts',
    `identifier=eq.${encodeURIComponent(identifier)}&success=eq.false&created_at=gte.${encodeURIComponent(since)}&select=id`);
  return rows.length >= limit;
}

async function recordAttempt(identifier, ip, success) {
  await db.insert('login_attempts', { identifier, ip, success });
}

/** Wraps a handler so thrown errors become clean JSON responses instead of crashing. */
function withHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error(e);
      fail(res, e.status || 500, e.status ? e.message : 'Internal server error');
    }
  };
}

module.exports = {
  ok, fail, requireMethod, generateToken, hashToken, clientIp, bearerToken,
  validEmail, requireUser, requireAdmin, tooManyAttempts, recordAttempt, withHandler,
};
