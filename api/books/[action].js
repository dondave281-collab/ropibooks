const crypto = require('crypto');
const db = require('../_lib/supabase');
const { ok, fail, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'list' && req.method === 'GET') {
    const books = await db.select('books', 'active=eq.true&select=id,title,author,price,format,description,cover_url&order=created_at.desc');
    return ok(res, { books });
  }

  if (action === 'upsert' && req.method === 'POST') {
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
    if (!existing.length) book = await db.insert('books', payload);
    else { const rows = await db.update('books', `id=eq.${encodeURIComponent(id)}`, payload); book = rows[0] || payload; }
    return ok(res, { book });
  }

  if (action === 'upload-pdf' && req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const { bookId = '', fileBase64 = '', mime = 'application/pdf' } = req.body || {};
    if (!bookId || !fileBase64) return fail(res, 422, 'bookId and fileBase64 are required.');
    if (mime !== 'application/pdf') return fail(res, 422, 'File must be a PDF.');
    const approxBytes = fileBase64.length * 0.75;
    if (approxBytes > 4 * 1024 * 1024) return fail(res, 413, 'PDF too large for this upload method (max ~4MB).');
    const path = `${bookId}/${crypto.randomBytes(8).toString('hex')}.pdf`;
    await db.uploadFile('book-pdfs', path, fileBase64, mime);
    await db.update('books', `id=eq.${encodeURIComponent(bookId)}`, { pdf_path: path });
    return ok(res, { ok: true, path });
  }

  fail(res, 404, 'Not found');
});
