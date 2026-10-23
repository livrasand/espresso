/* dashboard.js — repository browser for the Espresso control plane.
 *
 * Lists the paired nodes for the signed-in account and browses the
 * repositories on each node:
 *   GET /api/nodes                          → { nodes: [...] }
 *   GET /api/nodes/:id/repos                → { repositories: [{name,size}] }
 *   GET /api/gg/repos/:owner/:repo/branches → { branches: [...] }
 *   GET /api/gg/repos/:owner/:repo/tags     → { tags: [...] }
 * All management calls carry the X-ZKP-Token session header via
 * window.EspressoAuth. Anonymous listing works in trusted-network mode.
 */
'use strict';

(function () {
  const Auth = window.EspressoAuth;
  const API = '';

  const el = {
    account: document.getElementById('dash-account'),
    nodelist: document.getElementById('dash-nodelist'),
    nodelistEmpty: document.getElementById('dash-nodelist-empty'),
    refresh: document.getElementById('dash-refresh'),
    pairOpen: document.getElementById('dash-pair-open'),
    pairClose: document.getElementById('dash-pair-close'),
    pairModal: document.getElementById('dash-pair-modal'),
    pairForm: document.getElementById('dash-pair-form'),
    pairCode: document.getElementById('dash-pair-code'),
    pairNodeId: document.getElementById('dash-pair-nodeid'),
    pairSubmit: document.getElementById('dash-pair-submit'),
    pairStatus: document.getElementById('dash-pair-status'),
    title: document.getElementById('dash-title'),
    subtitle: document.getElementById('dash-subtitle'),
    status: document.getElementById('dash-status'),
    repolist: document.getElementById('dash-repolist'),
    repolistEmpty: document.getElementById('dash-repolist-empty'),
  };

  const state = {
    nodes: [],
    selected: null,
    username: '',
  };
  (async () => {
    try {
      const r = await fetch('/api/profile', { headers: Auth.authHeaders() });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.profile && d.profile.username) { state.username = d.profile.username; return; }
      if (d && d.suggested_username) {
        await fetch('/api/profile', { method: 'PUT', headers: Auth.authHeaders(), body: JSON.stringify({ username: d.suggested_username }) });
        state.username = d.suggested_username;
      }
    } catch {}
  })();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtBytes(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let x = v;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    const rounded = x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1);
    return rounded + ' ' + units[i];
  }

  async function getJson(path) {
    const res = await fetch(API + path, { headers: Auth.authHeaders() });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      throw new Error((body && body.error) || 'request failed (' + res.status + ')');
    }
    return body;
  }

  function setStatus(msg, isError) {
    el.status.textContent = msg || '';
    el.status.classList.toggle('is-error', !!isError);
  }

  function renderAccount() {
    const s = Auth.session();
    if (s.account) {
      el.account.innerHTML =
        esc(s.account) +
        ' <a href="/login" data-action="logout">logout</a>';
    } else {
      el.account.innerHTML =
        '<span class="dash-account-label">Not signed in</span> ' +
        '<a href="/login">sign in</a>';
    }
  }

  function renderNodes() {
    el.nodelist.innerHTML = state.nodes.map((n) => {
      const id = esc(n.id);
      const online = n.online === true;
      const active = n.id === state.selected ? ' is-active' : '';
      const meta = online
        ? 'online · ' + (Array.isArray(n.repositories) ? n.repositories.length : 0) + ' repos'
        : 'offline';
      return (
        '<li>' +
          '<button type="button" class="dash-node' + active + '" data-node="' + id + '">' +
            '<span class="dash-node-top">' +
              '<span class="dash-dot ' + (online ? 'is-online' : 'is-offline') + '"></span>' +
              '<span class="dash-node-name">' + esc(n.name || n.id) + '</span>' +
            '</span>' +
            '<span class="dash-node-meta">' + esc(meta) + '</span>' +
          '</button>' +
        '</li>'
      );
    }).join('');
    el.nodelistEmpty.hidden = state.nodes.length > 0;

    el.nodelist.querySelectorAll('[data-node]').forEach((btn) => {
      btn.addEventListener('click', () => selectNode(btn.getAttribute('data-node')));
    });
  }

  function renderRepos(repos) {
    if (!Array.isArray(repos) || repos.length === 0) {
      el.repolist.innerHTML = '';
      el.repolistEmpty.hidden = false;
      el.repolistEmpty.textContent = 'No repositories on this node yet.';
      return;
    }
    el.repolistEmpty.hidden = true;
    el.repolist.innerHTML = repos.map((r) => {
      const name = esc(r.name);
      return (
        '<li class="dash-repo">' +
          '<div class="dash-repo-head">' +
            '<span class="dash-repo-name">' + name + '</span>' +
            '<span class="dash-repo-size">' + esc(fmtBytes(r.size)) + '</span>' +
            '<button type="button" class="dash-delete-btn" data-repo="' + name + '">Delete</button>' +
          '</div>' +
          '<div class="dash-repo-detail"></div>' +
        '</li>'
      );
    }).join('');

    el.repolist.querySelectorAll('.dash-repo').forEach((li) => {
      const name = li.querySelector('.dash-repo-name').textContent;
      const detail = li.querySelector('.dash-repo-detail');
      loadRepoDetail(name, detail);
      const del = li.querySelector('.dash-delete-btn');
      if (del) {
        del.addEventListener('click', () => openDeleteModal(name));
      }
    });
  }

  function renderRefs(detail, branches, tags, commits, repo) {
    const chip = (x) => '<span class="dash-chip">' + esc(x) + '</span>';
    const group = (label, items) =>
      '<div class="dash-repo-detail-group">' +
        '<span class="dash-repo-detail-label">' + esc(label) + '</span>' +
        (items.length ? items.map(chip).join('') : '<span class="dash-chip">none</span>') +
      '</div>';
  const api = '/' + encodeURIComponent(Auth.session().account || '') + '/' + encodeURIComponent(repo || '');
  const ownerSlug = state.username ? (state.username) : (Auth.session().account || '');
  const cloneUrl = 'git clone ' + location.protocol + '//' + location.host + '/' + encodeURIComponent(ownerSlug) + '/' + encodeURIComponent(repo || '') + '.git';
     detail.innerHTML =
       group('Branches', branches) +
       group('Tags', tags) +
       group('Commits', commits) +
        '<div class="dash-repo-detail-group">' +
          '<span class="dash-repo-detail-label">Clone</span>' +
          '<span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<code class="dash-repo-code" style="margin:0;">' + esc(cloneUrl) + '</code>' +
            '<button type="button" class="dash-copy-btn" style="position:static;" data-clone="' + esc(cloneUrl) + '" onclick="(async(b)=>{const t=b.dataset.clone;try{if(navigator.clipboard)await navigator.clipboard.writeText(t);else{const x=document.createElement(\'textarea\');x.value=t;document.body.appendChild(x);x.select();document.execCommand(\'copy\');x.remove();}b.textContent=\'Copied\';setTimeout(()=>b.textContent=\'Copy\',1200);}catch(e){b.textContent=\'Error\';}})(this)">Copy</button>' +
          '</span>' +
        '</div>';
    detail.hidden = false;
  }

  async function loadRepoDetail(repo, detail) {
    if (!state.selected || !detail) return;
    const owner = Auth.session().account;
    detail.innerHTML = '<span class="dash-chip">Loading…</span>';
    try {
      const base = '/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
      const [b, t] = await Promise.all([
        getJson(base + '/branches'),
        getJson(base + '/tags'),
      ]);
      renderRefs(
        detail,
        Array.isArray(b && b.branches) ? b.branches : [],
        Array.isArray(t && t.tags) ? t.tags : [],
        Array.isArray(b && b.commits) ? b.commits : [],
        repo,
      );
      setStatus('');
    } catch (e) {
      detail.innerHTML = '<span class="dash-chip">unavailable</span>';
      setStatus(e.message, true);
    }
  }

  async function selectNode(id) {
    state.selected = id;
    renderNodes();
    const node = state.nodes.find((n) => n.id === id);
    el.title.textContent = node ? (node.name || node.id) : 'Repositories';
    const sub = node ? [
      node.firmware ? 'fw ' + node.firmware : null,
      'storage ' + fmtBytes(node.storage_free) + ' free of ' + fmtBytes(node.storage_max),
      node.online ? 'online' : 'offline',
    ].filter(Boolean).join(' · ') : '';
    el.subtitle.textContent = sub;

    if (!node || node.online !== true) {
      el.repolist.innerHTML = '';
      el.repolistEmpty.hidden = false;
      el.repolistEmpty.textContent = 'Node offline — repositories unavailable.';
      return;
    }

    setStatus('Loading repositories…');
    el.repolist.innerHTML = '';
    el.repolistEmpty.hidden = true;
    try {
      const data = await getJson('/api/nodes/' + encodeURIComponent(id) + '/repos');
      renderRepos(data && data.repositories);
      setStatus('');
    } catch (e) {
      el.repolistEmpty.hidden = false;
      el.repolistEmpty.textContent = 'Failed to load repositories.';
      setStatus(e.message, true);
    }
  }

  function openDeleteModal(repo) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML =
      '<div style="background:#1a1a1a;border:1px solid #f76f53;padding:1.25rem;max-width:420px;width:90%;font-family:ui-monospace,Menlo,monospace;color:#eee;">' +
        '<h3 style="margin:0 0 .75rem;color:#f76f53;">Delete repository</h3>' +
        '<p style="margin:.25rem 0;">Type the repository name <strong>' + esc(repo) + '</strong> to confirm.</p>' +
        '<input id="del-repo-name" style="width:100%;box-sizing:border-box;margin:.25rem 0;padding:.3rem;background:#0d0d0d;color:#eee;border:1px solid #444;" />' +
        '<p style="margin:.5rem 0 .25rem;">Type <strong>delete my repo</strong> to confirm.</p>' +
        '<input id="del-confirm-phrase" style="width:100%;box-sizing:border-box;margin:.25rem 0;padding:.3rem;background:#0d0d0d;color:#eee;border:1px solid #444;" />' +
        '<div style="display:flex;gap:.5rem;margin-top:.75rem;justify-content:flex-end;">' +
          '<button type="button" id="del-cancel" style="background:#333;color:#eee;border:1px solid #555;padding:.3rem .7rem;cursor:pointer;">Cancel</button>' +
          '<button type="button" id="del-submit" style="background:#f76f53;color:#1f1f1f;border:1px solid #f76f53;padding:.3rem .7rem;cursor:pointer;font-weight:600;">Delete</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const nameInput = overlay.querySelector('#del-repo-name');
    const phraseInput = overlay.querySelector('#del-confirm-phrase');
    const cancel = overlay.querySelector('#del-cancel');
    const submit = overlay.querySelector('#del-submit');
    cancel.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
    submit.addEventListener('click', async () => {
      if (nameInput.value.trim() !== repo) { setStatus('Repository name does not match.', true); return; }
      if (phraseInput.value.trim().toLowerCase() !== 'delete my repo') { setStatus('Confirmation phrase does not match.', true); return; }
      try {
        const res = await fetch(API + '/api/nodes/' + encodeURIComponent(state.selected) + '/repo/delete', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
          body: JSON.stringify({ repo }),
        });
        if (!res.ok) throw new Error('delete failed');
        overlay.remove();
        await selectNode(state.selected);
      } catch (e) {
        setStatus(e.message, true);
      }
    });
  }

  async function loadNodes() {
    renderAccount();
    setStatus('Loading nodes…');
    try {
      const data = await getJson('/api/nodes');
      state.nodes = Array.isArray(data && data.nodes) ? data.nodes : [];
      renderNodes();
      if (state.nodes.length === 0) {
        el.title.textContent = 'Repositories';
        el.subtitle.textContent = '';
        el.repolist.innerHTML = '';
        el.repolistEmpty.hidden = false;
        el.repolistEmpty.textContent = 'No nodes paired yet. Pair one from your device to get started.';
        setStatus('');
        return;
      }
      const stillThere = state.nodes.some((n) => n.id === state.selected);
      const next = stillThere ? state.selected
        : (state.nodes.find((n) => n.online === true) || state.nodes[0]).id;
      await selectNode(next);
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  async function pairNode(ev) {
    if (ev) ev.preventDefault();
    const code = (el.pairCode && el.pairCode.value || '').trim().toUpperCase();
    if (!code) {
      if (el.pairStatus) { el.pairStatus.textContent = 'Pairing code is required.'; el.pairStatus.classList.add('is-error'); }
      return;
    }
    if (el.pairSubmit) el.pairSubmit.disabled = true;
    if (el.pairStatus) { el.pairStatus.textContent = 'Pairing…'; el.pairStatus.classList.remove('is-error'); }
    try {
      const res = await fetch(API + '/api/nodes/pair', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
        body: JSON.stringify({ code }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok) throw new Error((body && body.error) || 'pairing failed (' + res.status + ')');
      if (el.pairStatus) { el.pairStatus.textContent = 'Paired node ' + (body && body.node_id ? body.node_id : '') + '.'; el.pairStatus.classList.remove('is-error'); }
      if (el.pairCode) el.pairCode.value = '';
      if (el.pairNodeId) el.pairNodeId.value = '';
      await loadNodes();
      // Poll briefly until the newly paired node comes online.
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        await loadNodes();
        const n = state.nodes.find((x) => x.id === state.selected);
        if ((n && n.online === true) || tries >= 10) clearInterval(poll);
      }, 2000);
      closePairModal();
    } catch (e) {
      if (el.pairStatus) { el.pairStatus.textContent = e.message; el.pairStatus.classList.add('is-error'); }
    } finally {
      if (el.pairSubmit) el.pairSubmit.disabled = false;
    }
  }

  window.__pairNode = pairNode;
  function openPairModal() {
    if (el.pairModal) el.pairModal.hidden = false;
    if (el.pairCode) el.pairCode.focus();
  }
  function closePairModal() {
    if (el.pairModal) el.pairModal.hidden = true;
  }
  if (el.pairOpen) el.pairOpen.addEventListener('click', openPairModal);
  if (el.pairClose) el.pairClose.addEventListener('click', closePairModal);
  if (el.pairModal) {
    el.pairModal.addEventListener('click', (ev) => {
      if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-close')) closePairModal();
    });
  }
  if (el.pairForm) el.pairForm.addEventListener('submit', pairNode);
  if (el.pairSubmit) el.pairSubmit.addEventListener('click', (ev) => { ev.preventDefault(); pairNode(ev); });
  if (el.refresh) el.refresh.addEventListener('click', loadNodes);

  if (el.account) {
    el.account.addEventListener('click', (ev) => {
      const link = ev.target.closest('[data-action="logout"]');
      if (!link) return;
      ev.preventDefault();
      Auth.clearSession();
      window.location.href = '/login';
    });
  }

  loadNodes();
})();
