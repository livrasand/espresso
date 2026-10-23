/* profile.js — public profile page.
 *
 * Loads the signed-in account's own profile (GET /api/profile) when a session
 * exists, or falls back to a guest state. Rendering, editing (PUT /api/profile)
 * and the synthesized activity heat map (GET /api/profiles/:u/activity) are
 * wired here. Public profiles are reachable at /profile?u=<username>.
 */
'use strict';

(function () {
  const Auth = window.EspressoAuth;
  const API = '';

  const el = {
    account: document.getElementById('profile-account'),
    layout: document.getElementById('profile-layout'),
    status: document.getElementById('profile-status'),
    avatar: document.getElementById('profile-avatar'),
    avatarFallback: document.getElementById('profile-avatar-fallback'),
    displayName: document.getElementById('profile-display-name'),
    username: document.getElementById('profile-username'),
    bio: document.getElementById('profile-bio'),
    links: document.getElementById('profile-links'),
    joined: document.getElementById('profile-joined'),
    nodes: document.getElementById('profile-nodes'),
    repos: document.getElementById('profile-repos'),
    editToggle: document.getElementById('profile-edit-toggle'),
    create: document.getElementById('profile-create'),
    activityTotal: document.getElementById('profile-activity-total'),
    heatmapGrid: document.getElementById('profile-heatmap-grid'),
    heatmapNote: document.getElementById('profile-heatmap-note'),
    editor: document.getElementById('profile-editor'),
    form: document.getElementById('profile-form'),
    inputDisplay: document.getElementById('profile-input-display'),
    inputBio: document.getElementById('profile-input-bio'),
    inputAvatar: document.getElementById('profile-input-avatar'),
    inputLinks: document.getElementById('profile-input-links'),
    save: document.getElementById('profile-save'),
    cancel: document.getElementById('profile-cancel'),
    guest: document.getElementById('profile-guest'),
  };

  const state = { profile: null, mine: false, nodes: 0, repos: 0 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(msg, isError) {
    el.status.textContent = msg || '';
    el.status.classList.toggle('is-error', Boolean(isError));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function initials(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const parts = s.split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0); }).join('') || '?';
  }

  /* ── rendering ─────────────────────────────────────────────────────── */

  function renderProfile(p) {
    state.profile = p;
    renderAccount();

    const display = p.display_name && p.display_name.trim() ? p.display_name : 'Anonymous';
    el.displayName.textContent = display;
    el.username.textContent = p.username ? '@' + p.username : '';
    el.bio.textContent = p.bio || '';
    if (el.links) {
      const urls = String(p.links || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      el.links.innerHTML = urls.map(function (u) {
        return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" class="profile-link">' + esc(u) + '</a>';
      }).join(' ');
    }
    el.joined.textContent = fmtDate(p.created_at);
    document.title = (p.display_name || p.username || 'Profile') + ' · Espresso';

    if (p.avatar) {
      el.avatar.src = p.avatar;
      el.avatar.hidden = false;
      el.avatarFallback.hidden = true;
      el.avatar.onerror = function () {
        el.avatar.hidden = true;
        el.avatarFallback.hidden = false;
      };
      el.avatarFallback.textContent = initials(display);
    } else {
      el.avatar.hidden = true;
      el.avatar.removeAttribute('src');
      el.avatarFallback.hidden = false;
      el.avatarFallback.textContent = initials(display);
    }
  }

  function renderAccount() {
    const s = Auth.session();
    el.account.innerHTML = s.account
      ? '<span>' + esc(s.account) + '</span>'
      : '<a href="/login">Sign in</a>';
  }

  function renderStats(activity) {
    const nodes = activity && typeof activity.nodes === 'number' ? activity.nodes : 0;
    const repos = activity && typeof activity.repositories === 'number' ? activity.repositories : 0;
    state.nodes = nodes;
    state.repos = repos;
    el.nodes.textContent = String(nodes);
    el.repos.textContent = String(repos);
  }

  /* ── heat map ──────────────────────────────────────────────────────── */

  function renderHeatmap(activity) {
    const days = activity && Array.isArray(activity.days) ? activity.days : [];
    el.heatmapGrid.innerHTML = '';
    if (days.length === 0) return;

    const frag = document.createDocumentFragment();
    days.forEach(function (d) {
      const cell = document.createElement('span');
      const level = typeof d.level === 'number' ? Math.max(0, Math.min(4, d.level)) : 0;
      cell.className = 'profile-heat-cell is-level-' + level;
      cell.title = d.date + ' — ' + (d.count || 0) + ' contributions';
      frag.appendChild(cell);
    });
    el.heatmapGrid.appendChild(frag);

    const total = typeof activity.total === 'number' ? activity.total : 0;
    el.activityTotal.textContent = total + ' contributions in the last year';
    el.heatmapNote.textContent = activity.approximate
      ? 'Approximated from paired nodes and repositories — not a commit history.'
      : '';
  }

  /* ── editor ────────────────────────────────────────────────────────── */

  function openEditor() {
    if (el.layout) el.layout.hidden = false;
    const p = state.profile || {};
    el.inputDisplay.value = p.display_name || '';
    el.inputBio.value = p.bio || '';
    el.inputAvatar.value = p.avatar || '';
    if (el.inputLinks) el.inputLinks.value = p.links || '';
    el.editor.hidden = false;
    el.editToggle.hidden = true;
    el.inputDisplay.focus();
  }

  function closeEditor() {
    el.editor.hidden = true;
    if (state.mine) el.editToggle.hidden = false;
  }

  async function saveProfile(ev) {
    ev.preventDefault();
    el.save.disabled = true;
    setStatus('Saving…', false);
    try {
      const res = await fetch(API + '/api/profile', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
        body: JSON.stringify({
          display_name: el.inputDisplay.value.trim(),
          bio: el.inputBio.value.trim(),
          avatar: el.inputAvatar.value.trim(),
          links: el.inputLinks ? el.inputLinks.value.trim() : '',
        }),
      });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok) throw new Error((body && body.error) || 'save failed (' + res.status + ')');
      renderProfile(body.profile);
      if (el.layout) el.layout.hidden = false;
      if (el.create) { el.create.hidden = true; el.create.style.display = 'none'; }
      el.editToggle.hidden = false;
      closeEditor();
      setStatus('Profile saved.', false);
      loadActivity(body.profile.username);
    } catch (err) {
      setStatus(err.message || 'save failed', true);
    } finally {
      el.save.disabled = false;
    }
  }

  async function createProfile() {
    if (!state.profile) state.profile = { username: '', display_name: '', bio: '', avatar: '', created_at: '' };
    el.create.disabled = true;
    setStatus('Creating profile…', false);
    try {
      const res = await fetch(API + '/api/profile', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
        body: JSON.stringify({
          username: state.profile.username || '',
          display_name: '',
          bio: '',
          avatar: '',
        }),
      });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok) throw new Error((body && body.error) || 'create failed (' + res.status + ')');
      if (el.layout) el.layout.hidden = false;
      renderProfile(body.profile);
      if (el.create) { el.create.hidden = true; el.create.style.display = 'none'; }
      el.editToggle.hidden = false;
      setStatus('Profile created.', false);
      setTimeout(function () { setStatus('', false); }, 3000);
      loadActivity(body.profile.username);
    } catch (err) {
      setStatus(err.message || 'create failed', true);
    } finally {
      el.create.disabled = false;
    }
  }

  /* ── loading ───────────────────────────────────────────────────────── */

  async function loadActivity(username) {
    if (!username) return;
    try {
      const res = await fetch(API + '/api/profiles/' + encodeURIComponent(username) + '/activity');
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok) throw new Error((body && body.error) || 'activity failed');
      renderHeatmap(body);
      renderStats(body);
    } catch (err) {
      el.heatmapNote.textContent = 'Activity unavailable.';
    }
  }

  async function loadPublic(username) {
    try {
      const res = await fetch(API + '/api/profiles/' + encodeURIComponent(username));
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok) throw new Error((body && body.error) || 'not found');
      if (el.layout) el.layout.hidden = false;
      renderProfile(body.profile);
      loadActivity(body.profile.username);
    } catch (err) {
      setStatus(err.message || 'Profile not found.', true);
    }
  }

  async function loadOwn() {
    try {
      const res = await fetch(API + '/api/profile', { headers: Auth.authHeaders() });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (res.status === 401) return showGuest();
      if (!res.ok) throw new Error((body && body.error) || 'failed to load profile');

      state.mine = true;
      if (body.profile) {
        if (el.layout) el.layout.hidden = false;
        renderProfile(body.profile);
        if (el.create) { el.create.hidden = true; el.create.style.display = 'none'; }
        el.editToggle.hidden = false;
        loadActivity(body.profile.username);
      } else {
        // No profile yet: show a create button before rendering anything.
        state.profile = { username: body.suggested_username || '', display_name: '', bio: '', avatar: '', created_at: '' };
        if (el.layout) el.layout.hidden = true;
        if (el.create) { el.create.hidden = false; el.create.style.display = ''; }
        el.editToggle.hidden = true;
        el.editor.hidden = true;
        el.displayName.textContent = 'Anonymous';
        el.username.textContent = body.suggested_username ? '@' + body.suggested_username : '';
        setStatus('Create your profile to appear at /profile/' + (body.suggested_username || ''), false);
      }
    } catch (err) {
      setStatus(err.message || 'Failed to load profile.', true);
    }
  }

  function showGuest() {
    state.mine = false;
    if (el.layout) el.layout.hidden = true;
    el.editToggle.hidden = true;
    el.editor.hidden = true;
    el.guest.hidden = false;
    el.heatmapGrid.innerHTML = '';
  }

  /* ── boot ──────────────────────────────────────────────────────────── */

  function boot() {
    renderAccount();

    el.editToggle.addEventListener('click', openEditor);
    if (el.create) el.create.addEventListener('click', createProfile);
    el.cancel.addEventListener('click', closeEditor);
    el.form.addEventListener('submit', saveProfile);

    const params = new URLSearchParams(location.search);
    const u = params.get('u');
    if (u) {
      loadPublic(u);
      return;
    }

    const s = Auth.session();
    if (!s.token) return showGuest();
    loadOwn();
  }

  boot();
})();
