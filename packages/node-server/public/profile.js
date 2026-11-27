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

  const ICONS = {
    github: '<svg class="octicon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path></svg>',
    link: '<svg class="octicon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a3.5 3.5 0 0 0 4.95 0l1.25-1.25a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018l-1.25 1.25a2 2 0 0 1-2.83-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .751.751 0 0 0 1.042-.018.751.751 0 0 0 .018-1.042 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 0 4.95Z"></path></svg>',
    check: '<svg class="octicon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>',
    copy: '<svg class="octicon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>',
  };

  const el = {
    account: document.getElementById('profile-account'),
    layout: document.getElementById('profile-layout'),
    rail: document.querySelector('.profile-rail'),
    status: document.getElementById('profile-status'),
    avatar: document.getElementById('profile-avatar'),
    avatarFallback: document.getElementById('profile-avatar-fallback'),
    avatarTrigger: document.getElementById('profile-avatar-trigger'),
    displayName: document.getElementById('profile-display-name'),
    username: document.getElementById('profile-username'),
    bio: document.getElementById('profile-bio'),
    links: document.getElementById('profile-links'),
    joined: document.getElementById('profile-joined'),
    nodes: document.getElementById('profile-nodes'),
    repos: document.getElementById('profile-repos'),
    editToggle: document.getElementById('profile-edit-toggle'),
    create: document.getElementById('profile-create'),
    createCard: document.getElementById('profile-create-card'),
    copyLink: document.getElementById('profile-copy-link'),
    copyTooltip: document.getElementById('profile-copy-tooltip'),
    activityTotal: document.getElementById('profile-activity-total'),
    heatmapGrid: document.getElementById('profile-heatmap-grid'),
    heatmapNote: document.getElementById('profile-heatmap-note'),
    editor: document.getElementById('profile-editor'),
    editorClose: document.getElementById('profile-editor-close'),
    form: document.getElementById('profile-form'),
    inputDisplay: document.getElementById('profile-input-display'),
    inputBio: document.getElementById('profile-input-bio'),
    bioCount: document.getElementById('profile-bio-count'),
    inputAvatar: document.getElementById('profile-input-avatar'),
    liveAvatarPreview: document.getElementById('profile-avatar-live-preview'),
    liveAvatarFallback: document.getElementById('profile-avatar-live-fallback'),
    inputLinks: document.getElementById('profile-input-links'),
    save: document.getElementById('profile-save'),
    cancel: document.getElementById('profile-cancel'),
    guest: document.getElementById('profile-guest'),
  };

  const state = { profile: null, mine: false, nodes: 0, repos: 0 };
  let statusTimeout = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(msg, isError) {
    if (!el.status) return;
    if (statusTimeout) {
      clearTimeout(statusTimeout);
      statusTimeout = null;
    }
    if (!msg) {
      el.status.textContent = '';
      el.status.classList.remove('is-visible', 'is-error', 'is-success');
      return;
    }
    el.status.textContent = msg;
    el.status.classList.add('is-visible');
    el.status.classList.toggle('is-error', Boolean(isError));
    el.status.classList.toggle('is-success', !isError);

    if (!isError) {
      statusTimeout = setTimeout(function () {
        if (el.status) {
          el.status.classList.remove('is-visible');
        }
      }, 4000);
    }
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

  function updateLiveAvatar() {
    if (!el.liveAvatarPreview || !el.liveAvatarFallback) return;
    const url = el.inputAvatar ? el.inputAvatar.value.trim() : '';
    const name = el.inputDisplay ? el.inputDisplay.value.trim() : '';
    const fallbackText = initials(name || (state.profile && state.profile.display_name) || 'Anonymous');

    if (url) {
      el.liveAvatarPreview.src = url;
      el.liveAvatarPreview.hidden = false;
      el.liveAvatarFallback.hidden = true;
      el.liveAvatarPreview.onerror = function () {
        el.liveAvatarPreview.hidden = true;
        el.liveAvatarFallback.hidden = false;
        el.liveAvatarFallback.textContent = fallbackText;
      };
      el.liveAvatarFallback.textContent = fallbackText;
    } else {
      el.liveAvatarPreview.hidden = true;
      el.liveAvatarPreview.removeAttribute('src');
      el.liveAvatarFallback.hidden = false;
      el.liveAvatarFallback.textContent = fallbackText;
    }
  }

  function updateBioCount() {
    if (!el.bioCount || !el.inputBio) return;
    const count = el.inputBio.value.length;
    el.bioCount.textContent = count + ' / 280';
    el.bioCount.classList.toggle('is-near-limit', count >= 260);
  }

  /* ── rendering ─────────────────────────────────────────────────────── */

  function renderProfile(p) {
    state.profile = p;
    renderAccount();

    const display = p.display_name && p.display_name.trim() ? p.display_name : 'Anonymous';
    el.displayName.textContent = display;
    el.username.textContent = p.username ? '@' + p.username : '';
    el.bio.textContent = p.bio || '';

    if (el.rail) {
      el.rail.classList.toggle('is-owner', Boolean(state.mine));
    }

    if (el.links) {
      const urls = String(p.links || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      el.links.innerHTML = urls.map(function (u) {
        let label = u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
        let icon = /github\.com/i.test(u) ? ICONS.github : ICONS.link;

        return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" class="profile-link">' +
          icon + '<span>' + esc(label) + '</span></a>';
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
        el.avatarFallback.textContent = initials(display);
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
    if (!el.account) return;
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
    if (el.nodes) el.nodes.textContent = String(nodes);
    if (el.repos) el.repos.textContent = String(repos);
  }

  /* ── heat map ──────────────────────────────────────────────────────── */

  function renderHeatmap(activity) {
    const days = activity && Array.isArray(activity.days) ? activity.days : [];
    if (!el.heatmapGrid) return;
    el.heatmapGrid.innerHTML = '';
    if (days.length === 0) {
      el.heatmapGrid.innerHTML = '<span class="profile-heatmap-empty">No activity recorded yet</span>';
      return;
    }

    const frag = document.createDocumentFragment();
    days.forEach(function (d) {
      const cell = document.createElement('span');
      const level = typeof d.level === 'number' ? Math.max(0, Math.min(4, d.level)) : 0;
      cell.className = 'profile-heat-cell is-level-' + level;
      cell.setAttribute('tabindex', '0');
      const count = d.count || 0;
      const label = count === 1 ? '1 contribution' : count + ' contributions';
      cell.title = d.date + ' — ' + label;
      cell.setAttribute('aria-label', d.date + ': ' + label);
      frag.appendChild(cell);
    });
    el.heatmapGrid.appendChild(frag);

    const total = typeof activity.total === 'number' ? activity.total : 0;
    if (el.activityTotal) {
      el.activityTotal.textContent = total + (total === 1 ? ' contribution in the last year' : ' contributions in the last year');
    }
    if (el.heatmapNote) {
      el.heatmapNote.textContent = activity.approximate
        ? 'Approximated from paired nodes and repositories — not a commit history.'
        : '';
    }
  }

  /* ── editor ────────────────────────────────────────────────────────── */

  function openEditor() {
    if (el.layout) el.layout.hidden = false;
    const p = state.profile || {};
    if (el.inputDisplay) el.inputDisplay.value = p.display_name || '';
    if (el.inputBio) el.inputBio.value = p.bio || '';
    if (el.inputAvatar) el.inputAvatar.value = p.avatar || '';
    if (el.inputLinks) el.inputLinks.value = p.links || '';
    if (el.editor) el.editor.hidden = false;
    if (el.editToggle) el.editToggle.hidden = true;

    updateLiveAvatar();
    updateBioCount();
    if (el.inputDisplay) el.inputDisplay.focus();
    if (el.editor) el.editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeEditor() {
    if (el.editor) el.editor.hidden = true;
    if (state.mine && el.editToggle) el.editToggle.hidden = false;
  }

  async function fetchOwnProfile() {
    try {
      const res = await fetch(API + '/api/profile', { headers: Auth.authHeaders() });
      if (!res.ok) return null;
      const body = await res.json();
      return (body && body.profile) || null;
    } catch (e) { return null; }
  }

  function showSaved(p, message) {
    renderProfile(p);
    if (el.layout) el.layout.hidden = false;
    if (el.create) { el.create.hidden = true; el.create.style.display = 'none'; }
    if (el.createCard) el.createCard.hidden = true;
    if (el.editToggle) el.editToggle.hidden = false;
    closeEditor();
    setStatus(message || 'Profile saved successfully.', false);
    loadActivity(p.username);
  }

  async function saveProfile(ev) {
    ev.preventDefault();
    if (el.save) el.save.disabled = true;
    setStatus('Saving profile…', false);
    const fields = {
      display_name: el.inputDisplay ? el.inputDisplay.value.trim() : '',
      bio: el.inputBio ? el.inputBio.value.trim() : '',
      avatar: el.inputAvatar ? el.inputAvatar.value.trim() : '',
      links: el.inputLinks ? el.inputLinks.value.trim() : '',
    };
    try {
      const res = await fetch(API + '/api/profile', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
        body: JSON.stringify(fields),
      });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok) {
        const failed = new Error((body && body.error) || 'save failed (' + res.status + ')');
        failed.status = res.status;
        throw failed;
      }
      showSaved(body.profile, 'Profile saved successfully.');
    } catch (err) {
      const saved = !err.status || err.status >= 500 ? await fetchOwnProfile() : null;
      if (saved && Object.keys(fields).every((k) => (saved[k] || '') === fields[k])) {
        showSaved(saved, 'Profile saved successfully.');
      } else {
        setStatus(err.message || 'Save failed', true);
      }
    } finally {
      if (el.save) el.save.disabled = false;
    }
  }

  function showCreated(p) {
    if (el.layout) el.layout.hidden = false;
    renderProfile(p);
    if (el.create) { el.create.hidden = true; el.create.style.display = 'none'; }
    if (el.createCard) el.createCard.hidden = true;
    if (el.editToggle) el.editToggle.hidden = false;
    setStatus('Profile created successfully!', false);
    loadActivity(p.username);
  }

  async function createProfile() {
    if (!state.profile) state.profile = { username: '', display_name: '', bio: '', avatar: '', created_at: '' };
    if (el.create) el.create.disabled = true;
    setStatus('Creating your Espresso profile…', false);
    const sent = { username: state.profile.username || '', display_name: '', bio: '', avatar: '' };
    try {
      const res = await fetch(API + '/api/profile', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
        body: JSON.stringify(sent),
      });
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok) {
        const failed = new Error((body && body.error) || 'create failed (' + res.status + ')');
        failed.status = res.status;
        throw failed;
      }
      showCreated(body.profile);
    } catch (err) {
      const saved = !err.status || err.status >= 500 ? await fetchOwnProfile() : null;
      if (saved && (!sent.username || saved.username === sent.username)) {
        showCreated(saved);
      } else {
        setStatus(err.message || 'Create profile failed', true);
      }
    } finally {
      if (el.create) el.create.disabled = false;
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
      if (el.heatmapNote) el.heatmapNote.textContent = 'Activity unavailable.';
    }
  }

  async function loadPublic(username) {
    try {
      const res = await fetch(API + '/api/profiles/' + encodeURIComponent(username));
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok) throw new Error((body && body.error) || 'not found');
      if (el.layout) el.layout.hidden = false;
      if (el.guest) el.guest.hidden = true;
      if (el.createCard) el.createCard.hidden = true;
      if (el.create) { el.create.hidden = true; el.create.style.display = 'none'; }
      state.mine = false;
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
        if (el.createCard) el.createCard.hidden = true;
        if (el.create) { el.create.hidden = true; el.create.style.display = 'none'; }
        if (el.guest) el.guest.hidden = true;
        renderProfile(body.profile);
        if (el.editToggle) el.editToggle.hidden = false;
        loadActivity(body.profile.username);
      } else {
        // No profile yet: show hero create card
        state.profile = { username: body.suggested_username || '', display_name: '', bio: '', avatar: '', created_at: '' };
        if (el.layout) el.layout.hidden = true;
        if (el.guest) el.guest.hidden = true;
        if (el.createCard) el.createCard.hidden = false;
        if (el.create) { el.create.hidden = false; el.create.style.display = ''; }
        if (el.editToggle) el.editToggle.hidden = true;
        if (el.editor) el.editor.hidden = true;
        if (el.displayName) el.displayName.textContent = 'Anonymous';
        if (el.username) el.username.textContent = body.suggested_username ? '@' + body.suggested_username : '';
        setStatus('Create your profile to appear at /profile?u=' + (body.suggested_username || ''), false);
      }
    } catch (err) {
      setStatus(err.message || 'Failed to load profile.', true);
    }
  }

  function showGuest() {
    state.mine = false;
    if (el.layout) el.layout.hidden = true;
    if (el.createCard) el.createCard.hidden = true;
    if (el.create) { el.create.hidden = true; el.create.style.display = 'none'; }
    if (el.editToggle) el.editToggle.hidden = true;
    if (el.editor) el.editor.hidden = true;
    if (el.guest) el.guest.hidden = false;
    if (el.heatmapGrid) el.heatmapGrid.innerHTML = '';
  }

  function copyProfileUrl() {
    const username = (state.profile && state.profile.username) || '';
    const url = username
      ? window.location.origin + '/profile?u=' + encodeURIComponent(username)
      : window.location.href;

    function onCopied() {
      if (el.copyTooltip) el.copyTooltip.textContent = 'Copied!';
      setStatus('Profile link copied to clipboard.', false);
      setTimeout(function () {
        if (el.copyTooltip) el.copyTooltip.textContent = 'Share';
      }, 2000);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(onCopied).catch(function () {
        promptCopy(url);
      });
    } else {
      promptCopy(url);
    }
  }

  function promptCopy(text) {
    const input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand('copy');
      if (el.copyTooltip) el.copyTooltip.textContent = 'Copied!';
      setStatus('Profile link copied to clipboard.', false);
      setTimeout(function () {
        if (el.copyTooltip) el.copyTooltip.textContent = 'Share';
      }, 2000);
    } catch (e) {
      setStatus('Copy: ' + text, false);
    }
    document.body.removeChild(input);
  }

  /* ── boot ──────────────────────────────────────────────────────────── */

  function boot() {
    renderAccount();

    if (el.editToggle) el.editToggle.addEventListener('click', openEditor);
    if (el.editorClose) el.editorClose.addEventListener('click', closeEditor);
    if (el.create) el.create.addEventListener('click', createProfile);
    if (el.cancel) el.cancel.addEventListener('click', closeEditor);
    if (el.form) el.form.addEventListener('submit', saveProfile);
    if (el.copyLink) el.copyLink.addEventListener('click', copyProfileUrl);

    // Click avatar on rail to edit if own profile
    if (el.avatarTrigger) {
      el.avatarTrigger.addEventListener('click', function () {
        if (state.mine) openEditor();
      });
    }

    // Live avatar preview in editor
    if (el.inputAvatar) {
      el.inputAvatar.addEventListener('input', updateLiveAvatar);
    }
    if (el.inputDisplay) {
      el.inputDisplay.addEventListener('input', updateLiveAvatar);
    }

    // Bio character counter
    if (el.inputBio) {
      el.inputBio.addEventListener('input', updateBioCount);
    }

    // Keyboard navigation (Esc to close editor, Cmd+Enter to submit)
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && el.editor && !el.editor.hidden) {
        closeEditor();
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && el.editor && !el.editor.hidden) {
        ev.preventDefault();
        if (el.form) el.form.requestSubmit();
      }
    });

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
