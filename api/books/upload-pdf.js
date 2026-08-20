const db = require('../_lib/supabase');
const { ok, fail, requireMethod, requireAdmin, withHandler } = require('../_lib/util');
const crypto = require('crypto');

// Body: { bookId, fileBase64, mime } — fileBase64 is the PDF encoded as base64 (no data: prefix).
// Hobby-tier Vercel caps request bodies around 4.5MB, so this suits smaller PDFs.
module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
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

  ok(res, { ok: true, path });
});
