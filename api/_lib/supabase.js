const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function assertConfigured() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    const err = new Error('Server misconfigured: Supabase env vars missing');
    err.status = 500;
    throw err;
  }
}

async function request(method, path, body, extraHeaders = {}) {
  assertConfigured();
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function select(table, query = '') {
  const r = await request('GET', `/rest/v1/${table}?${query}`);
  return Array.isArray(r.body) ? r.body : [];
}

async function insert(table, row) {
  const r = await request('POST', `/rest/v1/${table}`, row, { Prefer: 'return=representation' });
  if (r.status >= 400) {
    const err = new Error('Database insert failed: ' + JSON.stringify(r.body));
    err.status = 500;
    throw err;
  }
  return r.body[0] || {};
}

async function insertIgnoreDuplicate(table, row, onConflictColumns) {
  await request('POST', `/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflictColumns)}`, row, {
    Prefer: 'resolution=ignore-duplicates,return=minimal',
  });
}

async function update(table, query, patch) {
  const r = await request('PATCH', `/rest/v1/${table}?${query}`, patch, { Prefer: 'return=representation' });
  if (r.status >= 400) {
    const err = new Error('Database update failed: ' + JSON.stringify(r.body));
    err.status = 500;
    throw err;
  }
  return r.body;
}

async function del(table, query) {
  const r = await request('DELETE', `/rest/v1/${table}?${query}`);
  if (r.status >= 400) {
    const err = new Error('Database delete failed');
    err.status = 500;
    throw err;
  }
}

/** Upload a base64-encoded file to a private storage bucket. */
async function uploadFile(bucket, path, base64Data, mime) {
  assertConfigured();
  const buffer = Buffer.from(base64Data, 'base64');
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': mime,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error('File upload failed: ' + t);
    err.status = 500;
    throw err;
  }
}

async function createSignedUrl(bucket, path, expiresInSeconds = 300) {
  const r = await request('POST', `/storage/v1/object/sign/${bucket}/${path}`, { expiresIn: expiresInSeconds });
  if (r.status >= 400 || !r.body || !r.body.signedURL) return null;
  return `${SUPABASE_URL}/storage/v1${r.body.signedURL}`;
}

module.exports = { select, insert, insertIgnoreDuplicate, update, delete: del, uploadFile, createSignedUrl };
