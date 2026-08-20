const crypto = require('crypto');
const db = require('../_lib/supabase');
const { ok, fail, requireMethod, requireUser, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;
  const user = await requireUser(req, res);
  if (!user) return;

  const { items = [], delivery = null, paymentMethod = 'paystack' } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return fail(res, 422, 'Cart is empty.');

  const bookIds = items.map((i) => String(i.bookId || ''));
  const idsFilter = `id=in.(${bookIds.map(encodeURIComponent).join(',')})`;
  const books = await db.select('books', `${idsFilter}&select=id,title,price,format`);
  const booksById = Object.fromEntries(books.map((b) => [b.id, b]));

  let total = 0;
  const orderItems = [];
  for (const item of items) {
    const bookId = String(item.bookId || '');
    const qty = Math.max(1, parseInt(item.qty || 1, 10));
    const book = booksById[bookId];
    if (!book) return fail(res, 422, `Unknown book: ${bookId}`);
    total += book.price * qty;
    orderItems.push({ bookId, title: book.title, format: book.format, price: book.price, qty });
  }

  const orderRef = 'ROP-' + crypto.randomBytes(5).toString('hex').toUpperCase();

  const order = await db.insert('orders', {
    order_ref: orderRef,
    user_id: user.id,
    user_email: user.email,
    user_name: user.name,
    items: orderItems,
    total,
    payment_method: paymentMethod,
    status: 'pending',
    delivery,
  });

  if (paymentMethod !== 'paystack') return ok(res, { order });

  const secret = process.env.PAYSTACK_SECRET_KEY;
  const psRes = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      amount: Math.round(total * 100),
      currency: 'GHS',
      reference: orderRef,
      metadata: { order_id: order.id },
    }),
  });
  const psData = await psRes.json();

  if (!psData.status) return fail(res, 502, 'Could not initialize payment.');

  ok(res, {
    order,
    authorization_url: psData.data.authorization_url,
    access_code: psData.data.access_code,
    reference: psData.data.reference,
  });
});
