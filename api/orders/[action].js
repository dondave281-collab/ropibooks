const crypto = require('crypto');
const db = require('../_lib/supabase');
const { ok, fail, requireUser, requireAdmin, withHandler } = require('../_lib/util');

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'create' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return;

    const { items = [], delivery = null, paymentMethod = 'paystack' } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return fail(res, 422, 'Cart is empty.');

    const bookIds = items.map((i) => String(i.bookId || ''));
    const idsFilter = `id=in.(${bookIds.map(encodeURIComponent).join(',')})`;
    const books = await db.select('books', `${idsFilter}&select=id,title,price_digital,price_physical,has_digital,has_physical`);
    const booksById = Object.fromEntries(books.map((b) => [b.id, b]));

    let total = 0;
    const orderItems = [];
    for (const item of items) {
      const bookId = String(item.bookId || '');
      const format = item.format === 'physical' ? 'physical' : 'digital';
      const qty = Math.max(1, parseInt(item.qty || 1, 10));
      const book = booksById[bookId];
      if (!book) return fail(res, 422, `Unknown book: ${bookId}`);

      if (format === 'digital' && !book.has_digital) return fail(res, 422, `${book.title} is not available digitally.`);
      if (format === 'physical' && !book.has_physical) return fail(res, 422, `${book.title} is not available physically.`);

      const price = format === 'digital' ? Number(book.price_digital || 0) : Number(book.price_physical || 0);
      total += price * qty;
      orderItems.push({ bookId, title: book.title, format, price, qty });
    }

    const orderRef = 'ROP-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const order = await db.insert('orders', {
      order_ref: orderRef, user_id: user.id, user_email: user.email, user_name: user.name,
      items: orderItems, total, payment_method: paymentMethod, status: 'pending', delivery,
    });

    if (paymentMethod !== 'paystack') return ok(res, { order });

    const secret = process.env.PAYSTACK_SECRET_KEY;
    const psRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: user.email, amount: Math.round(total * 100), currency: 'GHS',
        reference: orderRef, metadata: { order_id: order.id },
      }),
    });
    const psData = await psRes.json();
    if (!psData.status) return fail(res, 502, 'Could not initialize payment.');

    return ok(res, {
      order, authorization_url: psData.data.authorization_url,
      access_code: psData.data.access_code, reference: psData.data.reference,
    });
  }

  if (action === 'verify' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const ref = String(req.query.reference || '');
    if (!ref) return fail(res, 422, 'reference is required.');
    const rows = await db.select('orders', `order_ref=eq.${encodeURIComponent(ref)}&user_id=eq.${user.id}&select=id,order_ref,status,total,items,created_at`);
    if (!rows.length) return fail(res, 404, 'Order not found.');
    return ok(res, { order: rows[0] });
  }

  // Customer-facing: only that user's own orders, no admin session required.
  if (action === 'mine' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const orders = await db.select('orders', `user_id=eq.${user.id}&select=id,order_ref,items,total,payment_method,status,created_at&order=created_at.desc`);
    return ok(res, { orders });
  }

  if (action === 'list' && req.method === 'GET') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const orders = await db.select('orders', 'select=*&order=created_at.desc');
    return ok(res, { orders });
  }

  if (action === 'update-status' && req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const { orderId = '', status = '' } = req.body || {};
    const allowed = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
    if (!orderId || !allowed.includes(status)) return fail(res, 422, 'orderId and a valid status are required.');
    const rows = await db.update('orders', `id=eq.${encodeURIComponent(orderId)}`, { status, updated_at: new Date().toISOString() });
    return ok(res, { order: rows[0] || null });
  }

  fail(res, 404, 'Not found');
});
