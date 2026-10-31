/* auth-client.js — account session client for the accounts API.
 *
 * Minimal replacement for the removed ZKP client. Talks to the
 * Mullvad-style account endpoints:
 *   POST /api/accounts        (mint)
 *   POST /api/accounts/login  (issue session token)
 *   POST /api/accounts/backup (number behind session)
 * Session tokens are time-limited HMAC tokens (24h); the server accepts
 * them via the X-ZKP-Token header (name kept for firmware compatibility).
 */
'use strict';

const API_BASE = '';
const TOKEN_KEY = 'espresso_session_token';
const ACCOUNT_KEY = 'espresso_account';
const ACCOUNTS_KEY = 'espresso_accounts';
const ACCOUNTS_MAX = 8;

/* ── Session helpers ───────────────────────────────────────────────── */

function readJson(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function session() {
  return {
    account: readJson(ACCOUNT_KEY),
    token: readJson(TOKEN_KEY),
  };
}

function saveSession(account, token) {
  try {
    localStorage.setItem(ACCOUNT_KEY, account || '');
    localStorage.setItem(TOKEN_KEY, token || '');
  } catch { /* storage unavailable */ }
  rememberAccount(account);
}

/* ── Known-accounts registry (so users don't lose their number) ─────── */

function readAccounts() {
  try {
    const arr = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((e) => e && e.account) : [];
  } catch { return []; }
}

function writeAccounts(list) {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

/** Record an account number as "known"; most-recent first. */
function rememberAccount(account) {
  const digits = String(account || '').replace(/\D/g, '');
  if (!digits) return readAccounts();
  const rest = readAccounts().filter((e) => e.account !== digits);
  const list = [{ account: digits, seen_at: new Date().toISOString() }, ...rest].slice(0, ACCOUNTS_MAX);
  writeAccounts(list);
  return list;
}

/** Remove a single account number from the known list. */
function forgetAccount(account) {
  const digits = String(account || '').replace(/\D/g, '');
  const list = readAccounts().filter((e) => e.account !== digits);
  writeAccounts(list);
  return list;
}

function knownAccounts() {
  return readAccounts();
}

/** Format a 16-digit number as spaced groups. */
function formatAccount(account) {
  return String(account || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
}

function clearSession() {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

function authHeaders() {
  const t = session().token;
  return t ? { 'X-ZKP-Token': t } : {};
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ── API calls ─────────────────────────────────────────────────────── */

/** Mint a new account; returns { account, session_token }. */
async function mintAccount() {
  const res = await fetch(API_BASE + '/api/accounts', { method: 'POST' });
  return checkResponse(res);
}

/** Log in with the 16-digit account number; returns { account, session_token }. */
async function login(account) {
  const digits = String(account || '').replace(/\D/g, '');
  const res = await fetch(API_BASE + '/api/accounts/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: digits }),
  });
  return checkResponse(res);
}

/** Return the account number behind the current session token. */
async function backupAccount() {
  const res = await fetch(API_BASE + '/api/accounts/backup', { method: 'POST', headers: authHeaders() });
  return checkResponse(res);
}

async function checkResponse(res) {
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new Error((body && body.error) || 'request failed (' + res.status + ')');
  }
  return body;
}

/* ── Public namespace ──────────────────────────────────────────────── */

window.EspressoAuth = {
  session,
  saveSession,
  clearSession,
  authHeaders,
  mintAccount,
  login,
  backupAccount,
  rememberAccount,
  forgetAccount,
  knownAccounts,
  formatAccount,
};

