const db = require('../_lib/supabase');
const { ok, fail, requireMethod, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const b = req.body || {};
  const id = String(b.id || '').trim();
  const title = String(b.title || '').trim();
  const format = String(b.format || '');

  if (!id || !title || !['digital', 'physical', 'both'].includes(format)) {
    return fail(res, 422, 'id, title, and a valid format are required.');
  }

  const payload = {
    id, title,
    author: String(b.author || 'Rev. Ruthanna Ankomah Tanor'),
    price: Number(b.price || 0),
    format,
    description: String(b.description || ''),
    cover_url: String(b.cover_url || ''),
    updated_at: new Date().toISOString(),
  };

  const existing = await db.select('books', `id=eq.${encodeURIComponent(id)}&select=id`);
  let book;
  if (!existing.length) {
    book = await db.insert('books', payload);
  } else {
    const rows = await db.update('books', `id=eq.${encodeURIComponent(id)}`, payload);
    book = rows[0] || payload;
  }
  ok(res, { book });
});
