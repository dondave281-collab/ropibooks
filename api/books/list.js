const db = require('../_lib/supabase');
const { ok, requireMethod, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;
  const books = await db.select('books', 'active=eq.true&select=id,title,author,price,format,description,cover_url&order=created_at.desc');
  ok(res, { books });
});
