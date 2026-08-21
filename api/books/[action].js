const crypto = require('crypto');
const db = require('../_lib/supabase');
const { ok, fail, requireAdmin, withHandler } = require('../_lib/util');

// Columns aliased back to the camelCase names the admin UI already expects.
const PUBLIC_SELECT = 'id,title,author,category,description,cover:cover_url,hasDigital:has_digital,hasPhysical:has_physical,priceDigital:price_digital,pricePhysical:price_physical,stock,featured';

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'list' && req.method === 'GET') {
    const books = await db.select('books', `active=eq.true&select=${PUBLIC_SELECT}&order=created_at.desc`);
    return ok(res, { books });
  }

  if (action === 'upsert' && req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const b = req.body || {};
    const id = String(b.id || '').trim();
    const title = String(b.title || '').trim();
    if (!id || !title) return fail(res, 422, 'id and title are required.');

    const hasDigital = !!b.hasDigital;
    const hasPhysical = !!b.hasPhysical;
    if (!hasDigital && !hasPhysical) return fail(res, 422, 'Book must be available as digital, physical, or both.');

    const payload = {
      id, title,
      author: String(b.author || 'Rev. Ruthanna Ankomah Tanor'),
      category: String(b.category || 'General'),
      description: String(b.description || ''),
      cover_url: String(b.cover || b.cover_url || ''),
      has_digital: hasDigital,
      has_physical: hasPhysical,
      price_digital: hasDigital ? Number(b.priceDigital || 0) : null,
      price_physical: hasPhysical ? Number(b.pricePhysical || 0) : null,
      stock: b.stock === '' || b.stock === undefined ? null : Number(b.stock),
      featured: !!b.featured,
      // legacy columns kept in sync so checkout (which reads price/format) still works
      price: hasDigital ? Number(b.priceDigital || 0) : Number(b.pricePhysical || 0),
      format: hasDigital && hasPhysical ? 'both' : hasDigital ? 'digital' : 'physical',
      updated_at: new Date().toISOString(),
    };

    const existing = await db.select('books', `id=eq.${encodeURIComponent(id)}&select=id`);
    let book;
    if (!existing.length) book = await db.insert('books', payload);
    else { const rows = await db.update('books', `id=eq.${encodeURIComponent(id)}`, payload); book = rows[0] || payload; }
    return ok(res, { book });
  }

  if (action === 'delete' && req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const id = String((req.body || {}).id || '').trim();
    if (!id) return fail(res, 422, 'id is required.');
    await db.update('books', `id=eq.${encodeURIComponent(id)}`, { active: false, updated_at: new Date().toISOString() });
    return ok(res, { ok: true });
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
