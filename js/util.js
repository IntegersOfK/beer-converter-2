// Shared utilities used across modules.

export const $  = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function fmt(n, digits = 1) {
  if (!isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) < 0.05) return n.toFixed(2);
  return n.toFixed(digits);
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'
  }[c]));
}

export function vibe(ms = 10) {
  try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ }
}
