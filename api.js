/**
 * API client for the Restorers of Paths backend.
 * Since the backend now lives in the SAME Vercel project as this frontend
 * (under /api), we call relative paths — no separate domain, no CORS setup needed.
 */
const API_BASE = ''; // same-origin — leave empty

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

async function api(path, { method = 'GET', body, admin = false } = {}) {
  const headers = {};
  const token = admin ? adminToken() : authToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data;
  try { data = await res.json(); } catch (e) { data = {}; }

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

/** Reads a File object and resolves to its base64 content (no data: prefix). */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const API = {
  // ---- Auth ----
  signup: (name, email, password) => api('/api/auth/signup', { method: 'POST', body: { name, email, password } }),
  login: (email, password) => api('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => api('/api/auth/logout', { method: 'POST' }),
  session: () => api('/api/auth/session'),

  // ---- Admin ----
  adminLogin: (username, password) => api('/api/admin/login', { method: 'POST', body: { username, password } }),
  adminSession: () => api('/api/admin/session', { admin: true }),
  adminUsers: () => api('/api/admin/users', { admin: true }),

  // ---- Books ----
  listBooks: () => api('/api/books/list'),
  upsertBook: (book) => api('/api/books/upsert', { method: 'POST', body: book, admin: true }),
  uploadPdf: async (bookId, file) => {
    const fileBase64 = await fileToBase64(file);
    return api('/api/books/upload-pdf', { method: 'POST', body: { bookId, fileBase64, mime: file.type }, admin: true });
  },

  // ---- Orders ----
  createOrder: (items, delivery, paymentMethod) =>
    api('/api/orders/create', { method: 'POST', body: { items, delivery, paymentMethod } }),
  verifyOrder: (reference) => api(`/api/orders/verify?reference=${encodeURIComponent(reference)}`),
  listOrders: () => api('/api/orders/list', { admin: true }),
  updateOrderStatus: (orderId, status) =>
    api('/api/orders/update-status', { method: 'POST', body: { orderId, status }, admin: true }),

  // ---- Library ----
  myLibrary: () => api('/api/library/list'),
  pdfUrl: (bookId) => api(`/api/library/pdf-url?bookId=${encodeURIComponent(bookId)}`),

  // ---- Subscribers / Messages ----
  subscribe: (email) => api('/api/subscribers/subscribe', { method: 'POST', body: { email } }),
  listSubscribers: () => api('/api/subscribers/list', { admin: true }),
  sendMessage: (name, email, message) => api('/api/messages/send', { method: 'POST', body: { name, email, message } }),
  listMessages: () => api('/api/messages/list', { admin: true }),
};
