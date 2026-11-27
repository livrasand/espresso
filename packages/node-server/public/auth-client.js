'use strict';

const API_BASE = '';
const TOKEN_KEY = 'espresso_session_token';
const ACCOUNT_KEY = 'espresso_account';
const ACCOUNTS_KEY = 'espresso_accounts';
const ACCOUNTS_MAX = 8;

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

function readAccounts() {
  try {
    const arr = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((e) => e && e.account) : [];
  } catch { return []; }
}

function writeAccounts(list) {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function rememberAccount(account) {
  const digits = String(account || '').replace(/\D/g, '');
  if (!digits) return readAccounts();
  const rest = readAccounts().filter((e) => e.account !== digits);
  const list = [{ account: digits, seen_at: new Date().toISOString() }, ...rest].slice(0, ACCOUNTS_MAX);
  writeAccounts(list);
  return list;
}

function forgetAccount(account) {
  const digits = String(account || '').replace(/\D/g, '');
  const list = readAccounts().filter((e) => e.account !== digits);
  writeAccounts(list);
  return list;
}

function knownAccounts() {
  return readAccounts();
}

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


async function mintAccount() {
  const res = await fetch(API_BASE + '/api/accounts', { method: 'POST' });
  return checkResponse(res);
}

async function login(account) {
  const digits = String(account || '').replace(/\D/g, '');
  const res = await fetch(API_BASE + '/api/accounts/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: digits }),
  });
  return checkResponse(res);
}

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
