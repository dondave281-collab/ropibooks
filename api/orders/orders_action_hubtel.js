const crypto = require('crypto');
const db = require('../_lib/supabase');
const { notifyAdmin } = require('../_lib/mailer');
const { ok, fail, requireUser, requireAdmin, withHandler } = require('../_lib/util');

const HUBTEL_INITIATE_URL = 'https://payproxyapi.hubtel.com/items/initiate';

function siteUrl() {
  return String(process.env.SITE_URL || 'https://www.ropibooks.com').replace(/\/$/, '');
}

// The callback URL is fixed and public, so it cannot prove a callback is genuine on its own.
// Instead each payment gets a secret, unguessable gateway_ref (sent to Hubtel as clientReference).
// Customers only ever see the public order_ref, so they cannot forge a callback for their order.
const GATEWAY_REF_RE = /^[a-f0-9]{32}$/;

function publicOrder(order) {
  const { gateway_ref, paystack_ref, ...safe } = order || {};
  return safe;
}

async function unlockLibrary(order) {
  if (!order.user_id) return;
  for (const item of order.items || []) {
    if (item.format === 'digital') {
      await db.insertIgnoreDuplicate('library', { user_id: order.user_id, book_id: item.bookId, order_id: order.id }, 'user_id,book_id');
    }
  }
}

// Hubtel's field casing differs between docs/versions, so read both.
function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

module.exports = withHandler(async (req, res) => {
  const action = req.query.action;

  if (action === 'create' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return;

    const { items = [], delivery = null, paymentMethod = 'hubtel' } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return fail(res, 422, 'Cart is empty.');
    if (!['hubtel', 'cod'].includes(paymentMethod)) return fail(res, 422, 'Unsupported payment method.');

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
    total = Math.round(total * 100) / 100;

    const orderRef = 'ROP-' + crypto.randomBytes(5).toString('hex').toUpperCase(); // public, shown to the customer
    const gatewayRef = crypto.randomBytes(16).toString('hex'); // secret, exactly 32 chars (Hubtel's maximum)
    const order = await db.insert('orders', {
      order_ref: orderRef, user_id: user.id, user_email: user.email, user_name: user.name,
      items: orderItems, total, payment_method: paymentMethod, status: 'pending', delivery,
      gateway_ref: paymentMethod === 'hubtel' ? gatewayRef : null,
    });

    const itemsSummary = orderItems.map((i) => `- ${i.title} (${i.format}) x${i.qty} — GHS ${i.price * i.qty}`).join('\n');
    notifyAdmin(
      `New order ${orderRef} — Restorers of Paths`,
      `A new order was placed.\n\nOrder ref: ${orderRef}\nCustomer: ${user.name} (${user.email})\nPayment method: ${paymentMethod}\nTotal: GHS ${total}\n\nItems:\n${itemsSummary}${delivery ? `\n\nDelivery:\n${delivery.name}, ${delivery.phone}\n${delivery.address}, ${delivery.city}` : ''}`
    );

    if (paymentMethod === 'cod') return ok(res, { order: publicOrder(order) });

    const clientId = process.env.HUBTEL_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
    const merchantAccountNumber = process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER;
    if (!clientId || !clientSecret || !merchantAccountNumber) {
      console.error('Hubtel env vars missing');
      return fail(res, 503, 'Online payment is not available right now. Please choose Cash on Delivery or try again later.');
    }

    const base = siteUrl();
    const hubRes = await fetch(HUBTEL_INITIATE_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        totalAmount: total,
        description: `Book order ${orderRef}`,
        callbackUrl: `${base}/api/orders/hubtel-callback`,
        returnUrl: `${base}/?order=${orderRef}`,
        cancellationUrl: `${base}/?cancelled=${orderRef}`,
        merchantAccountNumber,
        clientReference: gatewayRef,
      }),
    });

    let hubData = null;
    try { hubData = await hubRes.json(); } catch (e) { /* non-JSON error body */ }

    const checkoutUrl = hubData && hubData.data && hubData.data.checkoutUrl;
    if (!hubRes.ok || !hubData || String(hubData.responseCode) !== '0000' || !checkoutUrl) {
      console.error('Hubtel initiate failed:', hubRes.status, JSON.stringify(hubData));
      return fail(res, 502, 'Could not start the payment. Please try again.');
    }

    return ok(res, { order: publicOrder(order), checkout_url: checkoutUrl, reference: orderRef });
  }

  // Hubtel posts the final payment status here (fixed URL, no login).
  // A callback is only accepted if it carries the secret gateway_ref of a pending order, and the amount matches.
  if (action === 'hubtel-callback' && req.method === 'POST') {
    const body = req.body || {};
    const data = pick(body, 'Data', 'data') || {};
    const clientRef = String(pick(data, 'ClientReference', 'clientReference') || '');

    // Log the payload for diagnosis, with the secret reference masked.
    console.log('Hubtel callback received:', JSON.stringify(body).split(clientRef || '\u0000').join(clientRef.slice(0, 6) + '…'));

    if (!GATEWAY_REF_RE.test(clientRef)) return fail(res, 400, 'Invalid reference.');

    const rows = await db.select('orders', `gateway_ref=eq.${clientRef}&select=*`);
    const order = rows[0];
    if (!order) return fail(res, 404, 'Order not found.');
    const ref = order.order_ref;
    if (order.status !== 'pending') return ok(res, { ok: true }); // already handled (idempotent)

    const responseCode = String(pick(body, 'ResponseCode', 'responseCode') || '');
    const status = String(pick(data, 'Status', 'status') || pick(body, 'Status', 'status') || '').toLowerCase();
    const succeeded = (responseCode === '' || responseCode === '0000') && ['success', 'successful', 'completed', 'paid'].includes(status);

    if (!succeeded) {
      console.log(`Hubtel callback for ${ref}: not a success (code=${responseCode}, status=${status}); order left pending.`);
      return ok(res, { ok: true });
    }

    const paidAmount = pick(data, 'Amount', 'amount');
    if (paidAmount !== undefined && Math.abs(Number(paidAmount) - Number(order.total)) > 0.009) {
      console.error(`Hubtel amount mismatch for ${ref}: paid ${paidAmount}, expected ${order.total}`);
      return fail(res, 400, 'Amount mismatch.');
    }

    await db.update('orders', `id=eq.${order.id}`, {
      status: 'paid',
      paystack_ref: String(pick(data, 'CheckoutId', 'checkoutId') || ''), // Hubtel's checkout id, for reconciliation
      updated_at: new Date().toISOString(),
    });
    await unlockLibrary(order);

    notifyAdmin(
      `Payment confirmed ${ref} — Restorers of Paths`,
      `Payment received via Hubtel.\n\nOrder ref: ${ref}\nCustomer: ${order.user_name} (${order.user_email})\nAmount: GHS ${order.total}`
    );
    return ok(res, { ok: true });
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
    const orders = await db.select('orders', 'select=id,order_ref,user_id,user_email,user_name,items,total,payment_method,paystack_ref,status,delivery,created_at,updated_at&order=created_at.desc');
    return ok(res, { orders });
  }

  if (action === 'update-status' && req.method === 'POST') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const { orderId = '', status = '' } = req.body || {};
    const allowed = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
    if (!orderId || !allowed.includes(status)) return fail(res, 422, 'orderId and a valid status are required.');

    const existing = await db.select('orders', `id=eq.${encodeURIComponent(orderId)}&select=*`);
    if (!existing.length) return fail(res, 404, 'Order not found.');

    const rows = await db.update('orders', `id=eq.${encodeURIComponent(orderId)}`, { status, updated_at: new Date().toISOString() });

    // Lets the admin reconcile a payment whose callback never arrived: marking it paid also unlocks the digital books.
    if (status === 'paid') await unlockLibrary(existing[0]);

    return ok(res, { order: rows[0] || null });
  }

  fail(res, 404, 'Not found');
});
