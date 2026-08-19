/**
 * API client for the Restorers of Paths PHP backend.
 * Replaces the demo window.storage calls in index.html.
 *
 * Set API_BASE to your Hostinger backend URL, e.g.
 *   const API_BASE = 'https://api.yourdomain.com';
 */
const API_BASE = 'https://api.yourdomain.com'; // <-- CHANGE THIS

function authToken() {
  return localStorage.getItem('rop_token') || '';
}
function setAuthToken(token) {
  if (token) localStorage.setItem('rop_token', token);
  else localStorage.removeItem('rop_token');
}
function adminToken() {
  return localStorage.getItem('rop_admin_token') || '';
}
function setAdminToken(token) {
  if (token) localStorage.setItem('rop_admin_token', token);
  else localStorage.removeItem('rop_admin_token');
}

async function api(path, { method = 'GET', body, admin = false, isForm = false } = {}) {
  const headers = {};
  const token = admin ? adminToken() : authToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
  });

  let data;
  try { data = await res.json(); } catch (e) { data = {}; }

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

const API = {
  // ---- Auth ----
  signup: (name, email, password) => api('/api/auth/signup.php', { method: 'POST', body: { name, email, password } }),
  login: (email, password) => api('/api/auth/login.php', { method: 'POST', body: { email, password } }),
  logout: () => api('/api/auth/logout.php', { method: 'POST' }),
  session: () => api('/api/auth/session.php'),

  // ---- Admin ----
  adminLogin: (username, password) => api('/api/admin/login.php', { method: 'POST', body: { username, password } }),
  adminSession: () => api('/api/admin/session.php', { admin: true }),
  adminUsers: () => api('/api/admin/users.php', { admin: true }),

  // ---- Books ----
  listBooks: () => api('/api/books/list.php'),
  upsertBook: (book) => api('/api/books/upsert.php', { method: 'POST', body: book, admin: true }),
  uploadPdf: (bookId, file) => {
    const form = new FormData();
    form.append('bookId', bookId);
    form.append('pdf', file);
    return api('/api/books/upload-pdf.php', { method: 'POST', body: form, admin: true, isForm: true });
  },

  // ---- Orders ----
  createOrder: (items, delivery, paymentMethod) =>
    api('/api/orders/create.php', { method: 'POST', body: { items, delivery, paymentMethod } }),
  verifyOrder: (reference) => api(`/api/orders/verify.php?reference=${encodeURIComponent(reference)}`),
  listOrders: () => api('/api/orders/list.php', { admin: true }),
  updateOrderStatus: (orderId, status) =>
    api('/api/orders/update-status.php', { method: 'POST', body: { orderId, status }, admin: true }),

  // ---- Library ----
  myLibrary: () => api('/api/library/list.php'),
  pdfUrl: (bookId) => api(`/api/library/pdf-url.php?bookId=${encodeURIComponent(bookId)}`),

  // ---- Subscribers / Messages ----
  subscribe: (email) => api('/api/subscribers/subscribe.php', { method: 'POST', body: { email } }),
  listSubscribers: () => api('/api/subscribers/list.php', { admin: true }),
  sendMessage: (name, email, message) => api('/api/messages/send.php', { method: 'POST', body: { name, email, message } }),
  listMessages: () => api('/api/messages/list.php', { admin: true }),
};
