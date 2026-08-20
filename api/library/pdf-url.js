const db = require('../_lib/supabase');
const { ok, fail, requireMethod, requireUser, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;
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

  ok(res, { url, expiresInSeconds: 300 });
});
