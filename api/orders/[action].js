const crypto = require('crypto');
const db = require('../_lib/supabase');
const { notifyAdmin } = require('../_lib/mailer');
const { ok, fail, requireUser, requireAdmin, withHandler } = require('../_lib/util');

const HUBTEL_INITIATE_URL = 'https://payproxyapi.hubtel.com/items/initiate';
const HUBTEL_STATUS_BASE = 'https://rmsc.hubtel.com/v1/merchantaccount/merchants';

function siteUrl() {
  return String(process.env.SITE_URL || 'https://www.ropibooks.com').replace(/\/$/, '');
}

// The callback URL is fixed and public, so it cannot prove a callback is genuine on its own.
// Each payment gets a secret, unguessable gateway_ref (sent to Hubtel as clientReference).
// Customers only ever see the public order_ref, so they cannot forge a callback for their order.
const GATEWAY_REF_RE = /^[a-f0-9]{32}$/;

function publicOrder(order) {
  const { gateway_ref, paystack_ref, ...safe } = order || {};
  return safe;
}

function basicAuth() {
  return 'Basic ' + Buffer.from(`${process.env.HUBTEL_CLIENT_ID || ''}:${process.env.HUBTEL_CLIENT_SECRET || ''}`).toString('base64');
}

// Hubtel's field casing differs between docs/versions, so read both.
function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function mask(text, secret) {
  return secret ? String(text).split(secret).join(secret.slice(0, 6) + '…') : String(text);
}

// Every callback Hubtel sends is stored permanently (the secret reference is masked), with what we did about it.
// Logging must never break payment handling, so failures here are swallowed.
async function logCallback(req, body, clientRef) {
  try {
    let text = mask(JSON.stringify(body), clientRef);
    let payload;
    try { payload = JSON.parse(text.length > 20000 ? '{}' : text); } catch (e) { payload = { raw: text.slice(0, 20000) }; }
    const row = await db.insert('hubtel_callbacks', {
      payload,
      source_ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 255),
      outcome: 'received',
    });
    return row && row.id;
  } catch (e) {
    console.error('callback log failed:', e.message);
    return null;
  }
}

async function finishCallbackLog(id, outcome, note, order) {
  if (!id) return;
  try {
    await db.update('hubtel_callbacks', `id=eq.${id}`, {
      outcome,
      note: note ? String(note).slice(0, 500) : null,
      order_ref: order ? order.order_ref : null,
    });
  } catch (e) {
    console.error('callback log update failed:', e.message);
  }
}

async function unlockLibrary(order) {
  if (!order.user_id) return;
  for (const item of order.items || []) {
    if (item.format === 'digital') {
      await db.insertIgnoreDuplicate('library', { user_id: order.user_id, book_id: item.bookId, order_id: order.id }, 'user_id,book_id');
    }
  }
}

/**
 * Asks Hubtel directly whether this order was paid (their public transaction status check).
 * Returns { state }: 'paid' | 'not_paid' | 'mismatch' | 'unknown'.
 * Anything we can't read clearly is 'unknown' — callers must never treat 'unknown' as paid on their own.
 */
async function checkHubtelStatus(order) {
  const account = process.env.HUBTEL_COLLECTION_ACCOUNT_NUMBER || process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER;
  if (!account || !process.env.HUBTEL_CLIENT_ID || !process.env.HUBTEL_CLIENT_SECRET || !GATEWAY_REF_RE.test(String(order.gateway_ref || ''))) {
    return { state: 'unknown' };
  }
  const url = `${HUBTEL_STATUS_BASE}/${encodeURIComponent(account)}/transactions/status?clientReference=${encodeURIComponent(order.gateway_ref)}`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers: { Authorization: basicAuth(), Accept: 'application/json' }, signal: ctl.signal });
    } finally { clearTimeout(timer); }

    const text = await res.text();
    console.log(`Hubtel status check for ${order.order_ref}: HTTP ${res.status}`, mask(text.slice(0, 600), order.gateway_ref));
    if (!res.ok) return { state: 'unknown' };

    let body;
    try { body = JSON.parse(text); } catch (e) { return { state: 'unknown' }; }
    const d = pick(body, 'data', 'Data') || body;

    const echoed = pick(d, 'clientReference', 'ClientReference');
    if (echoed !== undefined && String(echoed) !== order.gateway_ref) return { state: 'unknown' };

    const status = String(pick(d, 'status', 'Status', 'transactionStatus', 'TransactionStatus') || '').toLowerCase().replace(/\s+/g, '');
    const PAID = ['paid', 'success', 'successful', 'completed'];
    const NOT_PAID = ['unpaid', 'failed', 'cancelled', 'canceled', 'expired', 'declined', 'pending', 'processing', 'inprogress', 'refunded'];

    if (PAID.includes(status)) {
      const amount = pick(d, 'amount', 'Amount', 'transactionAmount', 'TransactionAmount');
      if (amount !== undefined && Math.abs(Number(amount) - Number(order.total)) > 0.009) {
        console.error(`Hubtel status amount mismatch for ${order.order_ref}: Hubtel says ${amount}, order is ${order.total}`);
        return { state: 'mismatch' };
      }
      return { state: 'paid', checkoutId: String(pick(d, 'transactionId', 'TransactionId', 'checkoutId', 'CheckoutId') || '') };
    }
    if (NOT_PAID.includes(status)) return { state: 'not_paid' };
    return { state: 'unknown' };
  } catch (e) {
    console.error('Hubtel status check failed:', e.message);
    return { state: 'unknown' };
  }
}

// Atomically flips pending -> paid (so concurrent callbacks/checks can't double-process) and unlocks digital books.
async function settlePaid(order, hubtelRef, how) {
  const rows = await db.update('orders', `id=eq.${order.id}&status=eq.pending`, {
    status: 'paid',
    paystack_ref: hubtelRef || '', // Hubtel's own reference, for reconciliation
    updated_at: new Date().toISOString(),
  });
  await unlockLibrary(order); // idempotent
  const changed = Array.isArray(rows) && rows.length > 0;
  if (changed) {
    notifyAdmin(
      `Payment confirmed ${order.order_ref} — Restorers of Paths`,
      `Payment received via Hubtel (${how}).\n\nOrder ref: ${order.order_ref}\nCustomer: ${order.user_name} (${order.user_email})\nAmount: GHS ${order.total}`
    );
  }
  return changed;
}

// Re-checks a pending Hubtel order with Hubtel itself. Marks it paid only on a clear "paid" answer.
async function reconcileOrder(order, how) {
  if (order.status !== 'pending' || order.payment_method !== 'hubtel') return false;
  const check = await checkHubtelStatus(order);
  if (check.state !== 'paid') return false;
  return settlePaid(order, check.checkoutId, how);
}

const RECHECK_AFTER_MS = 6000;      // customer polling: at most one Hubtel check per order every few seconds
const ADMIN_RECHECK_AFTER_MS = 60000;
const RECHECK_WINDOW_MS = 7 * 86400000;

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

    const merchantAccountNumber = process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER;
    if (!process.env.HUBTEL_CLIENT_ID || !process.env.HUBTEL_CLIENT_SECRET || !merchantAccountNumber) {
      console.error('Hubtel env vars missing');
      return fail(res, 503, 'Online payment is not available right now. Please choose Cash on Delivery or try again later.');
    }

    const base = siteUrl();
    const hubRes = await fetch(HUBTEL_INITIATE_URL, {
      method: 'POST',
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
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
      console.error('Hubtel initiate failed:', hubRes.status, mask(JSON.stringify(hubData), gatewayRef));
      return fail(res, 502, 'Could not start the payment. Please try again.');
    }

    return ok(res, { order: publicOrder(order), checkout_url: checkoutUrl, reference: orderRef });
  }

  // Hubtel posts the final payment status here (fixed URL, no login).
  // The callback is only a nudge: we find the order by its secret reference, then ask Hubtel directly.
  if (action === 'hubtel-callback' && req.method === 'POST') {
    const body = req.body || {};
    const data = pick(body, 'Data', 'data') || {};
    const clientRef = String(pick(data, 'ClientReference', 'clientReference') || '');

    console.log('Hubtel callback received:', mask(JSON.stringify(body), clientRef));
    const logId = await logCallback(req, body, clientRef); // stored before anything can reject it

    if (!GATEWAY_REF_RE.test(clientRef)) {
      await finishCallbackLog(logId, 'rejected_invalid_reference', 'ClientReference missing or malformed');
      return fail(res, 400, 'Invalid reference.');
    }

    const rows = await db.select('orders', `gateway_ref=eq.${clientRef}&select=*`);
    const order = rows[0];
    if (!order) {
      await finishCallbackLog(logId, 'rejected_unknown_reference', 'No order has this reference');
      return fail(res, 404, 'Order not found.');
    }
    if (order.status !== 'pending') {
      await finishCallbackLog(logId, 'ignored_already_processed', `Order already ${order.status}`, order);
      return ok(res, { ok: true }); // already handled (idempotent)
    }

    const responseCode = String(pick(body, 'ResponseCode', 'responseCode') || '');
    const status = String(pick(data, 'Status', 'status') || pick(body, 'Status', 'status') || '').toLowerCase();
    const callbackSaysPaid = (responseCode === '' || responseCode === '0000') && ['success', 'successful', 'completed', 'paid'].includes(status);
    const paidAmount = pick(data, 'Amount', 'amount');
    if (paidAmount !== undefined && Math.abs(Number(paidAmount) - Number(order.total)) > 0.009) {
      console.error(`Hubtel amount mismatch for ${order.order_ref}: callback says ${paidAmount}, expected ${order.total}`);
      await finishCallbackLog(logId, 'rejected_amount_mismatch', `Callback amount ${paidAmount}, order total ${order.total}`, order);
      return fail(res, 400, 'Amount mismatch.');
    }

    const check = await checkHubtelStatus(order);
    if (check.state === 'paid') {
      await settlePaid(order, check.checkoutId || String(pick(data, 'CheckoutId', 'checkoutId') || ''), 'verified with Hubtel');
      await finishCallbackLog(logId, 'paid_verified', 'Hubtel status check confirmed payment', order);
    } else if (check.state === 'unknown' && callbackSaysPaid) {
      // Hubtel's status service could not be read (down, or an answer in a format we don't recognise).
      // Fall back to the callback itself: it carried the secret reference and the right amount.
      console.warn(`Order ${order.order_ref} marked paid from callback WITHOUT Hubtel confirmation (status check unavailable).`);
      await settlePaid(order, String(pick(data, 'CheckoutId', 'checkoutId') || ''), 'callback — not independently verified');
      await finishCallbackLog(logId, 'paid_unverified', 'Status check unavailable; accepted callback (secret reference + amount matched)', order);
    } else {
      console.log(`Hubtel callback for ${order.order_ref} not accepted as paid (check=${check.state}, callbackSaysPaid=${callbackSaysPaid}); order left pending.`);
      await finishCallbackLog(logId, 'not_accepted', `Status check: ${check.state}; callback says paid: ${callbackSaysPaid}`, order);
    }
    return ok(res, { ok: true });
  }

  if (action === 'verify' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return;
    const ref = String(req.query.reference || '');
    if (!ref) return fail(res, 422, 'reference is required.');

    let rows = await db.select('orders', `order_ref=eq.${encodeURIComponent(ref)}&user_id=eq.${user.id}&select=*`);
    if (!rows.length) return fail(res, 404, 'Order not found.');
    let order = rows[0];

    // Callback missed or slow? Ask Hubtel ourselves (throttled so polling can't hammer it).
    if (order.status === 'pending' && order.payment_method === 'hubtel') {
      const last = order.updated_at ? new Date(order.updated_at).getTime() : 0;
      if (Date.now() - last >= RECHECK_AFTER_MS) {
        await db.update('orders', `id=eq.${order.id}&status=eq.pending`, { updated_at: new Date().toISOString() });
        if (await reconcileOrder(order, 'confirmed on customer return')) {
          rows = await db.select('orders', `id=eq.${order.id}&select=*`);
          order = rows[0] || order;
        }
      }
    }
    const { id, order_ref, status, total, items, created_at } = order;
    return ok(res, { order: { id, order_ref, status, total, items, created_at } });
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

    // Opening the Orders tab doubles as reconciliation: re-check recent unpaid Hubtel orders with Hubtel.
    const since = new Date(Date.now() - RECHECK_WINDOW_MS).toISOString();
    const stale = new Date(Date.now() - ADMIN_RECHECK_AFTER_MS).toISOString();
    const pending = await db.select('orders', `status=eq.pending&payment_method=eq.hubtel&created_at=gte.${encodeURIComponent(since)}&updated_at=lt.${encodeURIComponent(stale)}&select=*&order=created_at.desc&limit=10`);
    await Promise.all(pending.map(async (o) => {
      try {
        await db.update('orders', `id=eq.${o.id}&status=eq.pending`, { updated_at: new Date().toISOString() });
        await reconcileOrder(o, 'confirmed on admin refresh');
      } catch (e) { console.error('reconcile failed for', o.order_ref, e.message); }
    }));

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

    // Manual override: marking an order paid also unlocks its digital books.
    if (status === 'paid') await unlockLibrary(existing[0]);

    return ok(res, { order: rows[0] || null });
  }

  fail(res, 404, 'Not found');
});
