export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
export function normalizeSku(input) {
  if (typeof input !== 'string') return null;
  const sku = input.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(sku) ? sku : null;
}
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}
