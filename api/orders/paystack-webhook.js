const crypto = require('crypto');
const db = require('../_lib/supabase');
const { ok, fail, requireMethod, withHandler } = require('../_lib/util');

// Must read the RAW body (not the auto-parsed one) to verify Paystack's signature correctly.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = withHandler(async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const raw = await readRawBody(req);
  const signature = req.headers['x-paystack-signature'] || '';
  const secret = process.env.PAYSTACK_SECRET_KEY || '';

  const expected = crypto.createHmac('sha512', secret).update(raw).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return fail(res, 401, 'Invalid signature.');
  }

  const event = JSON.parse(raw);
  if (event.event !== 'charge.success') return ok(res, { ok: true });

  const reference = event.data?.reference || '';
  if (!reference) return fail(res, 422, 'Missing reference.');

  const rows = await db.select('orders', `order_ref=eq.${encodeURIComponent(reference)}&select=*`);
  const order = rows[0];
  if (!order) return fail(res, 404, 'Order not found.');

  // Defense in depth: re-verify with Paystack's verify endpoint and check the amount matches.
  const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const verify = await verifyRes.json();

  const paidKobo = verify.data?.amount || 0;
  const expectedKobo = Math.round(Number(order.total) * 100);
  const verified = verify.data?.status === 'success' && paidKobo === expectedKobo;

  if (!verified) {
    console.error(`Paystack webhook amount/status mismatch for ${reference}`);
    return fail(res, 400, 'Verification failed.');
  }

  if (order.status !== 'paid') {
    await db.update('orders', `id=eq.${order.id}`, { status: 'paid', paystack_ref: reference, updated_at: new Date().toISOString() });

    if (order.user_id) {
      for (const item of order.items) {
        if (item.format === 'digital' || item.format === 'both') {
          await db.insertIgnoreDuplicate('library', { user_id: order.user_id, book_id: item.bookId, order_id: order.id }, 'user_id,book_id');
        }
      }
    }
  }

  ok(res, { ok: true });
});
