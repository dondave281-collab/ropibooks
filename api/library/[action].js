const db = require('../_lib/supabase');
const { ok, fail, requireUser, withHandler } = require('../_lib/util');

// A physical copy shows in the customer's library only after the admin has confirmed it by setting the
// order to this status in the admin Orders tab. Change this one word to use a different status.
const PHYSICAL_CONFIRMED_STATUS = 'delivered';

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'list' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const rows = await db.select('library', `user_id=eq.${user.id}&select=book_id,purchased_at,books(id,title,cover_url)`);

    // Physical copies come straight from the customer's admin-confirmed orders, so if the admin later
    // changes an order away from the confirmed status, its books disappear from the library again.
    const confirmed = await db.select('orders', `user_id=eq.${user.id}&status=eq.${PHYSICAL_CONFIRMED_STATUS}&select=order_ref,items,updated_at&order=updated_at.desc`);
    const physical = [];
    for (const o of confirmed) {
      for (const item of o.items || []) {
        if (item.format === 'physical') {
          physical.push({ bookId: item.bookId, title: item.title, qty: item.qty || 1, order_ref: o.order_ref, confirmedAt: o.updated_at });
        }
      }
    }
    return ok(res, { library: rows, physical });
  }

  if (action === 'pdf-url' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const bookId = String(req.query.bookId || '');
    if (!bookId) return fail(res, 422, 'bookId is required.');

    const owned = await db.select('library', `user_id=eq.${user.id}&book_id=eq.${encodeURIComponent(bookId)}&select=id`);
    if (!owned.length) return fail(res, 403, 'You do not have access to this item.');

    const books = await db.select('books', `id=eq.${encodeURIComponent(bookId)}&select=pdf_path`);
    const pdfPath = books[0]?.pdf_path;
    if (!pdfPath) return fail(res, 404, 'No PDF has been uploaded for this book yet.');

    const url = await db.createSignedUrl('book-pdfs', pdfPath, 300);
    if (!url) return fail(res, 500, 'Could not generate download link.');
    return ok(res, { url, expiresInSeconds: 300 });
  }

  fail(res, 404, 'Not found');
});
